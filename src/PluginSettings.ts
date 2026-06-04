export type CursorPosition = 'body' | 'end' | 'title-highlighted' | 'title';
export type CursorPositionOrNone = 'none' | CursorPosition;

export class PluginSettings {
  public debugMode = false;
  public excludedFolders: string[] = [];
  public onCreate: CursorPosition = 'title';
  public onOpen: CursorPositionOrNone = 'none';
}
