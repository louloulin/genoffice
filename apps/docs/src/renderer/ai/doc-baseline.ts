import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

/**
 * Doc as last seen by the AI pipeline (context build / read / own write); a
 * differing doc means the user edited in between. Kept in a leaf module so
 * boot-path code (file-actions streaming tail) can carry the baseline without
 * pulling the agent/tool chain into the entry chunk.
 */
const docBaseline = new WeakMap<Editor, ProseMirrorNode>()

export function markDocSeen(editor: Editor): void {
  docBaseline.set(editor, editor.state.doc)
}

/** A streamed load tail is not a user edit: appending at the end keeps every block index the model saw valid. */
export function carryDocSeen(editor: Editor, before: ProseMirrorNode): void {
  if (docBaseline.get(editor) === before) docBaseline.set(editor, editor.state.doc)
}

export function editedExternally(editor: Editor): boolean {
  const seen = docBaseline.get(editor)
  return seen !== undefined && seen !== editor.state.doc
}
