export type CursorPosition = 'title' | 'body' | 'title-highlighted' | 'end';

export class PluginSettings {
  public cursorPosition: CursorPosition = 'title';
}
