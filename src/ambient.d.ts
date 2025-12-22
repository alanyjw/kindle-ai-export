// Ambient module declarations for dependencies that either:
// - ship ESM entrypoints without matching `.d.ts` for the exact import path, or
// - are optional at install time but required at runtime for some features.

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  const pdfjs: any
  export default pdfjs
  export const getDocument: any
}

declare module 'pdfjs-dist/build/pdf.mjs' {
  const pdfjs: any
  export default pdfjs
  export const getDocument: any
}

declare module '@napi-rs/canvas' {
  export const createCanvas: any
}
