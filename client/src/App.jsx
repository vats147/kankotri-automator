import React, { useState, useEffect, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Rnd } from 'react-rnd';
import axios from 'axios';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Worker setup
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const API_URL = 'http://localhost:5001';

function App() {
  const [clientName, setClientName] = useState('');
  const [pdfFile, setPdfFile] = useState(null);
  const [pdfFilename, setPdfFilename] = useState(null);
  const [csvFile, setCsvFile] = useState(null);
  const [csvData, setCsvData] = useState([]);
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [numPages, setNumPages] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [textBoxes, setTextBoxes] = useState([]);
  const [previewRowIndex, setPreviewRowIndex] = useState(0);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [selectedHeader, setSelectedHeader] = useState('');

  const pdfWrapperRef = useRef(null);

  const handlePdfUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setPdfFile(file);

    const formData = new FormData();
    formData.append('pdf', file);
    try {
      const res = await axios.post(`${API_URL}/api/upload-pdf`, formData);
      setPdfFilename(res.data.filename);
    } catch (err) {
      console.error("Upload failed", err);
    }
  };

  const removePdf = () => {
    setPdfFile(null);
    setPdfFilename(null);
    setNumPages(null);
    setPageNumber(1);
  };

  const handleCsvUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setCsvFile(file);

    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target.result;
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      if (lines.length > 0) {
        const headers = lines[0].split(',').map(h => h.trim());
        setCsvHeaders(headers);
        if (headers.length > 0) setSelectedHeader(headers[0]);

        const data = [];
        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',');
          const row = {};
          headers.forEach((h, index) => row[h] = values[index]);
          data.push(row);
        }
        setCsvData(data);
      }
    };
    reader.readAsText(file);
  };

  const onDocumentLoadSuccess = ({ numPages }) => {
    setNumPages(numPages);
  };

  const addTextBox = (header, x = 50, y = 50) => {
    setTextBoxes([
      ...textBoxes,
      {
        id: Date.now(),
        fieldName: header,
        page: pageNumber,
        x,
        y,
        width: 200,
        height: 30,
        fontSize: 20
      }
    ]);
  };

  const handlePdfClick = (e) => {
    if (!selectedHeader) return;
    // Only add if clicking on the page directly (not on an existing box)
    if (e.target.closest('.react-rnd')) return;

    // Get coordinates relative to the page
    // The Page component renders a canvas. We need to find the relative click position.
    // e.nativeEvent.offsetX/Y works if the target is the element we want.
    // But react-pdf structure is complex.
    // Let's rely on the wrapper ref.
    if (pdfWrapperRef.current) {
      const rect = pdfWrapperRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Adjust for scroll if needed (though we are using client coordinates relative to rect)
      // Also need to account for page offset if we have multiple pages rendered? 
      // Here we render one page.
      // Also need to account for the fact that the click might be outside the page area if we have margins.
      // But let's assume the wrapper is tight to the page.

      addTextBox(selectedHeader, x, y);
    }
  };

  const updateTextBox = (id, data) => {
    setTextBoxes(textBoxes.map(b => b.id === id ? { ...b, ...data } : b));
  };

  const removeTextBox = (id) => {
    setTextBoxes(textBoxes.filter(b => b.id !== id));
  };

  const handleGenerate = async () => {
    if (!clientName || !pdfFilename || !csvFile) {
      alert("Please fill all fields and upload files");
      return;
    }
    setLoading(true);
    setGenerationStatus('Saving config...');

    const configBoxes = textBoxes.map(box => ({
      ...box,
      xPct: box.x / pageSize.width,
      yPct: box.y / pageSize.height,
      widthPct: box.width / pageSize.width,
      heightPct: box.height / pageSize.height
    }));

    try {
      await axios.post(`${API_URL}/api/save-config`, {
        clientName,
        pdfFilename,
        textBoxes: configBoxes
      });

      setGenerationStatus('Generating & Zipping PDFs...');
      const formData = new FormData();
      formData.append('csv', csvFile);
      formData.append('clientName', clientName);

      const res = await axios.post(`${API_URL}/api/generate`, formData, { responseType: 'arraybuffer' });

      // Check for error (JSON disguised as arraybuffer)
      const contentType = res.headers['content-type'];
      if (contentType && contentType.includes('application/json')) {
        const text = new TextDecoder().decode(res.data);
        const json = JSON.parse(text);
        throw new Error(json.message || 'Server error');
      }

      // Trigger Download
      const blob = new Blob([res.data], { type: 'application/zip' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${clientName}_pdfs.zip`);
      document.body.appendChild(link);
      link.click();

      setTimeout(() => {
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      }, 100);

      setGenerationStatus('Download started!');
    } catch (err) {
      console.error(err);
      let msg = 'Error generating files';
      if (err.response && err.response.data) {
        try {
          const text = new TextDecoder().decode(err.response.data);
          const json = JSON.parse(text);
          msg = json.message || msg;
        } catch (e) { }
      } else if (err.message) {
        msg = err.message;
      }
      setGenerationStatus(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadPreview = async () => {
    if (!pdfFilename || !csvData.length) return;

    const configBoxes = textBoxes.map(box => ({
      ...box,
      xPct: box.x / pageSize.width,
      yPct: box.y / pageSize.height,
      widthPct: box.width / pageSize.width,
      heightPct: box.height / pageSize.height
    }));

    try {
      const res = await axios.post(`${API_URL}/api/generate-preview`, {
        pdfFilename,
        textBoxes: configBoxes,
        rowData: csvData[previewRowIndex]
      }, { responseType: 'arraybuffer' });

      // Check if the response is actually an error (JSON)
      const contentType = res.headers['content-type'];
      if (contentType && contentType.includes('application/json')) {
        const text = new TextDecoder().decode(res.data);
        const json = JSON.parse(text);
        alert(`Error: ${json.message || 'Unknown error'}`);
        return;
      }

      const blob = new Blob([res.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `preview_${previewRowIndex + 1}.pdf`);
      document.body.appendChild(link);

      // Small delay to ensure the browser registers the click and download attribute
      setTimeout(() => {
        link.click();
        setTimeout(() => {
          document.body.removeChild(link);
          window.URL.revokeObjectURL(url);
        }, 100);
      }, 0);

    } catch (err) {
      console.error("Preview failed", err);
      if (err.response && err.response.data) {
        // Try to parse arraybuffer as text
        try {
          const text = new TextDecoder().decode(err.response.data);
          const json = JSON.parse(text);
          alert(`Failed to generate preview: ${json.message || text.substring(0, 100)}`);
        } catch (e) {
          alert(`Failed to generate preview: Server returned error`);
        }
      } else {
        alert("Failed to generate preview: " + (err.message || "Unknown error"));
      }
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 p-8 font-sans flex flex-col h-screen">
      <h1 className="text-3xl font-bold mb-4 text-gray-800">PDF Automator</h1>

      <div className="flex flex-1 gap-8 overflow-hidden">

        {/* Sidebar Controls */}
        <div className="w-1/3 bg-white p-6 rounded-lg shadow-md flex flex-col gap-4 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-gray-700">Client Name</label>
            <input
              type="text"
              className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2"
              value={clientName}
              onChange={e => setClientName(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Upload PDF</label>
            {!pdfFile ? (
              <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-gray-300 border-dashed rounded-lg cursor-pointer bg-gray-50 hover:bg-gray-100">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <p className="mb-2 text-sm text-gray-500"><span className="font-semibold">Click to upload PDF</span></p>
                </div>
                <input type="file" accept=".pdf" className="hidden" onChange={handlePdfUpload} />
              </label>
            ) : (
              <div className="flex items-center justify-between p-2 border rounded bg-green-50 border-green-200">
                <span className="truncate text-sm text-green-700">{pdfFile.name}</span>
                <button onClick={removePdf} className="text-red-500 hover:text-red-700 font-bold px-2">✕</button>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Upload CSV</label>
            <label className="flex flex-col items-center justify-center w-full h-12 border border-gray-300 rounded-lg cursor-pointer bg-gray-50 hover:bg-gray-100">
              <span className="text-sm text-gray-500">{csvFile ? csvFile.name : "Click to upload CSV"}</span>
              <input type="file" accept=".csv" className="hidden" onChange={handleCsvUpload} />
            </label>
          </div>

          {csvHeaders.length > 0 && (
            <div className="border-t pt-4">
              <h3 className="font-semibold mb-2">Add Fields</h3>
              <p className="text-xs text-gray-500 mb-2">Select a field and click on the PDF to add it.</p>
              <select
                className="w-full border p-2 rounded mb-2"
                value={selectedHeader}
                onChange={e => setSelectedHeader(e.target.value)}
              >
                {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
              <button
                onClick={() => addTextBox(selectedHeader)}
                className="w-full bg-blue-100 text-blue-700 py-1 rounded hover:bg-blue-200 text-sm"
              >
                Add "{selectedHeader}" to Center
              </button>
            </div>
          )}

          {/* List of Added Text Boxes */}
          <div className="border-t pt-4 flex-1 overflow-y-auto">
            <h3 className="font-semibold mb-2">Added Fields</h3>
            {textBoxes.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No fields added yet.</p>
            ) : (
              <ul className="space-y-2">
                {textBoxes.map(box => (
                  <li
                    key={box.id}
                    className={`flex justify-between items-center p-2 rounded text-sm cursor-pointer ${box.page === pageNumber ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50'}`}
                    onClick={() => setPageNumber(box.page)}
                  >
                    <span>{box.fieldName} (Page {box.page})</span>
                    <button onClick={(e) => { e.stopPropagation(); removeTextBox(box.id); }} className="text-red-500 hover:text-red-700">✕</button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {csvData.length > 0 && (
            <div className="border-t pt-4">
              <label className="block text-sm font-medium text-gray-700">Preview Row: {previewRowIndex + 1}</label>
              <input
                type="range"
                min="0"
                max={csvData.length - 1}
                value={previewRowIndex}
                onChange={e => setPreviewRowIndex(parseInt(e.target.value))}
                className="w-full"
              />
              <button
                onClick={handleDownloadPreview}
                className="w-full mt-2 py-2 px-4 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 font-medium text-sm"
              >
                Download Preview PDF
              </button>
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={loading}
            className={`w-full py-3 px-4 rounded text-white font-bold shadow ${loading ? 'bg-gray-400' : 'bg-green-600 hover:bg-green-700'}`}
          >
            {loading ? 'Processing...' : 'Generate All Files'}
          </button>

          {generationStatus && <p className="mt-2 text-sm text-center text-gray-600">{generationStatus}</p>}
        </div>

        {/* PDF Preview Area */}
        <div className="flex-2 w-2/3 bg-gray-200 p-4 rounded-lg overflow-auto flex justify-center relative">
          {pdfFile ? (
            <div className="relative" ref={pdfWrapperRef} onClick={handlePdfClick}>
              <Document
                file={pdfFile}
                onLoadSuccess={onDocumentLoadSuccess}
                className="shadow-lg"
              >
                <Page
                  pageNumber={pageNumber}
                  width={600} // Fixed width for preview consistency
                  onLoadSuccess={(page) => setPageSize({ width: page.width, height: page.height })}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                />
              </Document>

              {/* Overlays */}
              {textBoxes.filter(b => b.page === pageNumber).map(box => (
                <Rnd
                  key={box.id}
                  size={{ width: box.width, height: box.height }}
                  position={{ x: box.x, y: box.y }}
                  onDragStop={(e, d) => updateTextBox(box.id, { x: d.x, y: d.y })}
                  onResizeStop={(e, direction, ref, delta, position) => {
                    updateTextBox(box.id, {
                      width: ref.style.width,
                      height: ref.style.height,
                      ...position,
                    });
                  }}
                  bounds="parent"
                  cancel=".delete-button"
                  className="border-2 border-blue-500 bg-blue-100 bg-opacity-30 flex items-center justify-center cursor-move group"
                  onClick={(e) => e.stopPropagation()} // Prevent adding new box when clicking existing one
                >
                  <span className="text-xs font-bold text-blue-800 pointer-events-none select-none">
                    {csvData.length > 0 ? csvData[previewRowIndex][box.fieldName] : box.fieldName}
                  </span>
                  <button
                    className="delete-button absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                    onMouseDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTextBox(box.id);
                    }}
                  >
                    ×
                  </button>
                </Rnd>
              ))}

              {numPages && (
                <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-white px-4 py-1 rounded shadow flex gap-4 z-10">
                  <button disabled={pageNumber <= 1} onClick={(e) => { e.stopPropagation(); setPageNumber(p => p - 1); }}>&lt;</button>
                  <span>Page {pageNumber} of {numPages}</span>
                  <button disabled={pageNumber >= numPages} onClick={(e) => { e.stopPropagation(); setPageNumber(p => p + 1); }}>&gt;</button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              Please upload a PDF to start
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

export default App;
