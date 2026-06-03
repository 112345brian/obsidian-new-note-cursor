export type CursorPosition = 'title' | 'body' | 'end' | 'title-highlighted';
export type CursorPositionOrNone = CursorPosition | 'none';

export class PluginSettings {
  public onCreate: CursorPosition = 'title';
  public onOpen: CursorPositionOrNone = 'none';
}
