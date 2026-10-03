import { createPopup } from './popup.js';
import { suggestUniqueFileName } from './media-helpers.js';
import { t } from './preferences.js';

export function chooseUploadName(name: string, names: Set<string>): Promise<string | null> {
  if (
    ![...names].some(
      (value) => value.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase(),
    )
  )
    return Promise.resolve(name);
  return new Promise((resolve) => {
    const popup = createPopup(t('duplicateTitle'));
    let result: string | null = null;
    popup.onClose(() => resolve(result));
    const explanation = document.createElement('p');
    explanation.textContent = t('duplicateExplanation', { name });
    const label = document.createElement('label');
    label.textContent = t('name');
    const input = document.createElement('input');
    input.value = suggestUniqueFileName(name, names);
    input.maxLength = 255;
    input.required = true;
    label.append(input);
    const error = document.createElement('p');
    error.setAttribute('role', 'alert');
    const actions = document.createElement('div');
    actions.className = 'popup-actions';
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.textContent = t('keepName');
    keep.onclick = () => {
      result = name;
      popup.close();
    };
    const save = document.createElement('button');
    save.className = 'button-primary';
    save.type = 'submit';
    save.textContent = t('saveAs');
    actions.append(keep, save);
    const form = document.createElement('form');
    form.append(explanation, label, error, actions);
    form.onsubmit = (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (
        !value ||
        Array.from(value).some(
          (char) => (char.codePointAt(0) ?? 0) < 32 || char.codePointAt(0) === 127,
        ) ||
        [...names].some(
          (other) => other.normalize('NFC').toLowerCase() === value.normalize('NFC').toLowerCase(),
        )
      ) {
        error.textContent = t('duplicateInvalid');
        return;
      }
      result = value;
      popup.close();
    };
    popup.body.append(form);
    input.focus();
    input.select();
  });
}
