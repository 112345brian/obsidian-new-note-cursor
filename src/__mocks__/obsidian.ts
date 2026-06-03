// Minimal stub of the Obsidian runtime module for unit tests.
// Only exports that are actually referenced at runtime (not just in types) need to be here.

export class MarkdownView {}
export class TFile {}
export class TAbstractFile {}
export class Plugin {
  public app: unknown;
  public manifest: unknown;
  public registerEvent(_ref: unknown): void {}
  public addSettingTab(_tab: unknown): void {}
}
export class PluginSettingTab {}
export class Setting {}
export class Notice {
  constructor(_msg: string) {}
}
export class Component {}
export class Events {}
export class WorkspaceLeaf {}

export const Platform = {
  isMobile: false,
  isDesktop: true,
  isIosApp: false,
  isAndroidApp: false,
};

export interface MarkdownFileInfo {
  editor: {
    focus(): void;
    getLine(n: number): string;
    lineCount(): number;
    setCursor(pos: unknown): void;
  } | null;
  file: { path: string } | null;
}
