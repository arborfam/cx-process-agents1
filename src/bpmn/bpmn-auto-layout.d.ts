// Типи для bpmn-auto-layout@2.0.0-alpha.2 (пакет не постачає власних оголошень).
declare module 'bpmn-auto-layout' {
  export class LayoutError extends Error {
    code: string;
    elementId: string;
    relatedElementIds: string[];
  }
  export class LayoutWarning extends Error {
    code: string;
    elementId: string;
    relatedElementIds: string[];
  }
  export function layoutProcess(xml: string): Promise<{ xml: string; warnings: LayoutWarning[] }>;
}
