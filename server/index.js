require("regenerator-runtime/runtime");
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const csv = require('csv-parser');
const archiver = require('archiver');
const { chromium } = require('playwright');

const app = express();
const PORT = 5001;

app.use(cors());
app.use(express.json());

// Ensure directories exist
const uploadDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

// Multer setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    },
});
const upload = multer({ storage });

// Database (simple JSON file)
const DB_FILE = path.join(__dirname, 'db.json');
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ clients: [], logs: [] }, null, 2));
}

const readDb = () => JSON.parse(fs.readFileSync(DB_FILE));
const writeDb = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

// Helper: Render text to image using Playwright
async function renderTextToImage(text, fontSize, color = 'red') {
    const browser = await chromium.launch();
    const page = await browser.newPage();

    // Font path
    const fontPath = path.join(__dirname, '..', 'NotoSansGujarati-Bold.ttf');
    const fontExists = fs.existsSync(fontPath);
    const fontUrl = fontExists ? `file://${fontPath}` : 'https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSansGujarati/NotoSansGujarati-Bold.ttf';

    const htmlContent = `
    <html>
    <head>
        <style>
            @font-face {
                font-family: 'GujaratiFont';
                src: url('${fontUrl}') format('truetype');
            }
            body {
                margin: 0;
                padding: 0;
                background: transparent;
            }
            .text {
                font-family: 'GujaratiFont', sans-serif;
                font-size: ${fontSize * 4}px; /* High res */
                color: ${color};
                font-weight: bold;
                display: inline-block;
                white-space: nowrap;
                padding: 5px;
            }
        </style>
    </head>
    <body>
        <div id="content" class="text">${text}</div>
    </body>
    </html>
    `;

    await page.setContent(htmlContent);
    const element = page.locator('#content');
    const buffer = await element.screenshot({ type: 'png', omitBackground: true });

    // Get dimensions to calculate scaling
    const box = await element.boundingBox();

    await browser.close();
    return { buffer, width: box.width, height: box.height };
}

// Routes

// 1. Upload PDF
app.post('/api/upload-pdf', upload.single('pdf'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded');
    res.json({ filename: req.file.filename, path: req.file.path });
});

// 2. Save Configuration (Client + TextBoxes)
app.post('/api/save-config', (req, res) => {
    const { clientName, pdfFilename, textBoxes } = req.body;
    const db = readDb();

    const existingClientIndex = db.clients.findIndex(c => c.name === clientName);
    const clientData = {
        name: clientName,
        pdfFilename,
        textBoxes,
        updatedAt: new Date().toISOString()
    };

    if (existingClientIndex >= 0) {
        db.clients[existingClientIndex] = clientData;
    } else {
        db.clients.push(clientData);
    }

    writeDb(db);
    res.json({ success: true, message: 'Configuration saved' });
});

// 3. Upload CSV and Generate
app.post('/api/generate', upload.single('csv'), async (req, res) => {
    const { clientName } = req.body;
    const csvFile = req.file;

    if (!csvFile || !clientName) {
        return res.status(400).send('Missing CSV or Client Name');
    }

    const db = readDb();
    const client = db.clients.find(c => c.name === clientName);

    if (!client) {
        return res.status(404).send('Client not found');
    }

    const results = [];
    fs.createReadStream(csvFile.path)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            try {
                const pdfPath = path.join(uploadDir, client.pdfFilename);
                const existingPdfBytes = fs.readFileSync(pdfPath);

                // Create client output folder
                const clientOutputDir = path.join(outputDir, clientName);
                if (!fs.existsSync(clientOutputDir)) fs.mkdirSync(clientOutputDir, { recursive: true });

                // Clear existing files in output dir to avoid zipping old files? 
                // Or maybe just overwrite. For now, let's just generate.

                const generatedFiles = [];

                for (const row of results) {
                    const pdfDoc = await PDFDocument.load(existingPdfBytes);
                    const pages = pdfDoc.getPages();

                    for (const box of client.textBoxes) {
                        const pageIndex = box.page - 1;
                        if (pageIndex >= 0 && pageIndex < pages.length) {
                            const page = pages[pageIndex];
                            const { width, height } = page.getSize();

                            const x = box.xPct * width;
                            const y = height - (box.yPct * height) - (box.heightPct * height); // PDF y is from bottom

                            const text = row[box.fieldName] || '';
                            if (!text) continue;

                            // Render text to image
                            const { buffer, width: imgW, height: imgH } = await renderTextToImage(text, 20, 'red');
                            const embeddedImage = await pdfDoc.embedPng(buffer);

                            // Scale down (we rendered at 4x)
                            const scale = 0.25;
                            const pdfImgW = imgW * scale;
                            const pdfImgH = imgH * scale;

                            page.drawImage(embeddedImage, {
                                x: x,
                                y: y, // Adjust Y if needed to match baseline
                                width: pdfImgW,
                                height: pdfImgH,
                            });
                        }
                    }

                    // Save PDF
                    const nameKey = Object.keys(row)[0];
                    // Allow Unicode characters, only remove illegal filesystem chars
                    const safeName = (row[nameKey] || 'output').replace(/[<>:"/\\|?*]+/g, '_').trim();
                    const outPath = path.join(clientOutputDir, `${safeName}.pdf`);
                    const pdfBytes = await pdfDoc.save();
                    fs.writeFileSync(outPath, pdfBytes);
                    generatedFiles.push(outPath);
                }

                // Create Zip
                const archive = archiver('zip', {
                    zlib: { level: 9 } // Sets the compression level.
                });

                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', `attachment; filename=${clientName}_pdfs.zip`);

                archive.pipe(res);

                // Append files from the output directory
                archive.directory(clientOutputDir, false);

                await archive.finalize();

            } catch (error) {
                console.error(error);
                // If headers sent, we can't send error status. 
                if (!res.headersSent) {
                    res.status(500).send('Error generating PDFs');
                }
            }
        });
});

// 3.5 Generate Single Preview
app.post('/api/generate-preview', async (req, res) => {
    const { pdfFilename, textBoxes, rowData } = req.body;

    if (!pdfFilename || !rowData) {
        return res.status(400).send('Missing PDF filename or row data');
    }

    try {
        const pdfPath = path.join(uploadDir, pdfFilename);
        if (!fs.existsSync(pdfPath)) return res.status(404).send('PDF not found');

        const existingPdfBytes = fs.readFileSync(pdfPath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        const pages = pdfDoc.getPages();

        for (const box of textBoxes) {
            const pageIndex = box.page - 1;
            if (pageIndex >= 0 && pageIndex < pages.length) {
                const page = pages[pageIndex];
                const { width, height } = page.getSize();

                const x = box.xPct * width;
                const y = height - (box.yPct * height) - (box.heightPct * height);

                const text = rowData[box.fieldName] || '';
                if (!text) continue;

                // Render text to image
                const { buffer, width: imgW, height: imgH } = await renderTextToImage(text, 20, 'red');
                const embeddedImage = await pdfDoc.embedPng(buffer);

                // Scale down (we rendered at 4x)
                const scale = 0.25;
                const pdfImgW = imgW * scale;
                const pdfImgH = imgH * scale;

                page.drawImage(embeddedImage, {
                    x: x,
                    y: y,
                    width: pdfImgW,
                    height: pdfImgH,
                });
            }
        }

        const pdfBytes = await pdfDoc.save();

        // Send as a downloadable file
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=preview.pdf');
        res.send(Buffer.from(pdfBytes));

    } catch (error) {
        console.error("Preview Generation Error:", error);
        res.status(500).send(`Error generating preview: ${error.message}`);
    }
});


// 4. Logs API
app.get('/api/logs', (req, res) => {
    const db = readDb();
    res.json(db.logs || []);
});

app.post('/api/logs', (req, res) => {
    const { name, number, status, message } = req.body;
    const db = readDb();
    if (!db.logs) db.logs = [];

    db.logs.push({
        timestamp: new Date().toISOString(),
        name,
        number,
        status,
        message
    });

    writeDb(db);
    res.json({ success: true });
});


app.use('/uploads', express.static('uploads'));

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
