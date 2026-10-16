// "Import from Figma" for Morfa: Figma's REST JSON → a DesignDocument (docs/design-tool.md).
// Pure: no DOM, no network. The browser reads the file with the user's token and uploads the
// pictures (src/design/import/figma); this module only maps.

export {
  importFigmaFile, documentJsonBytes, measureFigmaImport, figmaPagesOver, planFigmaParts, FigmaImportError, COMPONENTS_PAGE_ID, utf8Length,
  type FigmaImportOptions, type FigmaImportResult, type FigmaLimit, type FigmaLimitHit, type FigmaImportMeasure, type FigmaPageMeasure, type FigmaImportPart,
} from './import-file';
export {withUploadedImages, figmaImageRefs, type UploadedImage} from './images';
export {figmaPages, missingComponents, pageOfNode, type FigmaPageSummary} from './pages';
export {matchFigmaFont, fontKey} from './fonts';
export {FIGMA_REPORT_GROUPS, type FigmaImportReport, type FigmaReportGroup, type FigmaReportItem, type FigmaFontSubstitution} from './report';
export type {FigmaFile, FigmaNode} from './rest-types';
