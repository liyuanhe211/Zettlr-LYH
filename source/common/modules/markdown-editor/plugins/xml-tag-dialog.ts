import { xmlTagName } from '../util/xml-tags'

export interface XmlTagDialog { close: () => void }

/** A renderer-local modal. It never writes to the editor, even provisionally. */
export function openXmlTagDialog (parent: HTMLElement, complete: (name: string|null) => void): XmlTagDialog {
  const document = parent.ownerDocument
  const dialog = document.createElement('dialog')
  dialog.className = 'cm-xml-tag-dialog'
  dialog.setAttribute('aria-label', 'Insert XML Tag')
  const form = document.createElement('form')
  const title = document.createElement('h2')
  title.textContent = 'Insert XML Tag'
  const label = document.createElement('label')
  label.textContent = 'Tag label'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Label, e.g. last prompt'
  input.autocomplete = 'off'
  label.appendChild(input)
  const preview = document.createElement('p')
  preview.className = 'cm-xml-tag-preview'
  preview.setAttribute('aria-live', 'polite')
  const actions = document.createElement('div')
  actions.className = 'cm-xml-tag-actions'
  const insert = document.createElement('button')
  insert.type = 'submit'
  insert.textContent = 'Insert Tag'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  actions.append(insert, cancel)
  form.append(title, label, preview, actions)
  dialog.appendChild(form)
  parent.appendChild(dialog)
  let closed = false
  const finish = (name: string|null): void => {
    if (closed) {return}
    closed = true
    dialog.remove()
    complete(name)
  }
  const updatePreview = (): void => {
    const name = xmlTagName(input.value)
    preview.textContent = name === '' ? 'Type a label with a letter or digit' : `<${name}> … </${name}>`
    insert.disabled = name === ''
  }
  input.addEventListener('input', updatePreview)
  cancel.addEventListener('click', () => { finish(null) })
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null) })
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); finish(null) }
    // An IME confirmation must not also submit the tag.
    if (event.key === 'Enter' && event.isComposing) {event.preventDefault()}
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    const name = xmlTagName(input.value)
    if (name !== '') {finish(name)}
  })
  updatePreview()
  dialog.showModal()
  input.focus({ preventScroll: true })
  return { close: () => { finish(null) } }
}
