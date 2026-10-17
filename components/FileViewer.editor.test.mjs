import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewer = readFileSync(new URL("./FileViewer.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const editor = readFileSync(new URL("./FileEditor.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const theme = readFileSync(new URL("../app/native-theme.css", import.meta.url), "utf8");

test("the editor is code-split and only loaded for text files", () => {
  assert.match(viewer, /const FileEditor = dynamic\(\(\) => import\("\.\/FileEditor"\)/);
  assert.match(viewer, /editing && draft !== null \? \(\n\s*<FileEditor/);
});

test("saving echoes the last-read mtime so a stale write is refused", () => {
  assert.match(viewer, /getFileApiUrl\(filePath, "write", sourceSessionId\)/);
  assert.match(viewer, /JSON\.stringify\(\{ content, baseMtimeMs: data\.mtimeMs \}\)/);
  assert.match(viewer, /response\.status === 409/);
});

test("unsaved edits survive a tab switch and warn before unload", () => {
  assert.match(viewer, /setFileDraft\(filePath, draftRef\.current, dataRef\.current\?\.mtimeMs\)/);
  assert.match(viewer, /getFileDraft\(filePath\)/);
  assert.match(viewer, /addEventListener\("beforeunload"/);
});

test("a CRLF file keeps its line endings on save", () => {
  assert.match(viewer, /const editorEol = data\?\.content\.includes\("\\r\\n"\) \? "\\r\\n" : "\\n"/);
  assert.match(viewer, /draft\.replace\(\/\\n\/g, editorEol\)/);
});

test("the watcher does not clobber an unsaved draft", () => {
  assert.match(viewer, /if \(dirtyRef\.current\) \{\n\s*if \(fromChange\) setDiskChanged\(true\);/);
});

test("CodeMirror saves on Mod-s and reports user edits", () => {
  assert.match(editor, /key: "Mod-s"/);
  assert.match(editor, /EditorView\.updateListener\.of/);
  assert.match(editor, /if \(update\.docChanged && !programmaticRef\.current\)/);
  assert.match(editor, /languageExtension/);
});

test("the editor host fills its pane", () => {
  assert.match(theme, /\.file-editor-host \{/);
  assert.match(theme, /\.file-editor-host \.cm-editor \{/);
});
