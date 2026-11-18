declare module "pdf-parse" {
  const pdfParse: (data: Buffer) => Promise<{ text?: string; numpages?: number }>;
  export default pdfParse;
}
declare module "mammoth" {
  const mammoth: {
    extractRawText(input: { buffer: Buffer }): Promise<{ value?: string; messages?: unknown[] }>;
  };
  export default mammoth;
}
