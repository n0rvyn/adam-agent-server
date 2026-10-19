// One-time script to generate one_page.pdf fixture using pdf-lib
import { PDFDocument } from "pdf-lib";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const doc = await PDFDocument.create();
doc.addPage([595, 842]); // A4 portrait
const pdfBytes = await doc.save();
writeFileSync(resolve(import.meta.dirname, "one_page.pdf"), pdfBytes);
console.log("one_page.pdf written");
