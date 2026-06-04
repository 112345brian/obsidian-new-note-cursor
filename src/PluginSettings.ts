export type CursorPosition = 'body' | 'end' | 'title-highlighted' | 'title';
export type CursorPositionOrNone = 'none' | CursorPosition;

export class PluginSettings {
  public debugMode = false;
  public excludedFolders: string[] = [];
  public onCreate: CursorPosition = 'title';
  public onOpen: CursorPositionOrNone = 'none';
  // When title-highlighted mode is active, pressing the first character of this
  // String appends it to the title instead of replacing the selected text.
  // Empty = disabled. Example: ' - ' lets you press Space to get 'timestamp - '.
  // When title-highlighted mode is active, pressing this key moves the cursor
  // Directly to the body. Leave empty to disable. Example: 'Enter'.
  public titleBodyKey = '';
  public titleSeparator = '';
}
