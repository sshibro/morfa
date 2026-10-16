// The vector editor (docs/design-tool.md §Client engine): open it with `enterVectorEdit` or by
// setting `editing = {kind: 'vector', id}` once `installVectorEditing(store, {notify})` runs for the
// store; the canvas then routes the pointer to the 'vector-edit', 'vector-bend' or 'pen' tool
// (registered with the core tools) and `VectorEditBar` shows its tools and "Done".

export {VECTOR_EDIT_TOOLS, editedVectorId, enterVectorEdit, exitVectorEdit, installVectorEditing, notify, selectedKeys, sessionOf, setSelectedKeys, subscribeAnchors, writeNetwork, type Notify, type VectorSession} from './session';
export {deleteSelectedAnchors, nudgeAnchors, selectAllAnchors, VectorEditTool, createVectorBendTool, createVectorEditTool} from './tool';
export * from './model';
