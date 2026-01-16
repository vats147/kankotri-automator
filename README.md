# PDF Automator

## Prerequisites
- Node.js installed

## Setup

1. **Backend**
   ```bash
   cd server
   npm install
   ```

2. **Frontend**
   ```bash
   cd client
   npm install
   ```

## Running the App

1. **Start Backend** (Runs on port 5001)
   ```bash
   cd server
   node index.js
   ```

2. **Start Frontend** (Runs on port 5173)
   ```bash
   cd client
   npm run dev
   ```

## Usage
1. Open http://localhost:5173
2. Enter Client Name.
3. Upload PDF.
4. Upload CSV.
5. Drag and drop fields onto the PDF preview.
6. Click "Generate All".
7. Find generated PDFs in `server/output/<ClientName>`.
