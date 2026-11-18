/**
 * Settings → Move to another server.
 *
 * Export: one package with every media file in its folders plus playlists,
 * history, profiles, artwork and settings — as a .zip download or a folder
 * on a drive. Import: bring such a package in; everything is relinked to
 * the new folders and Vault restarts.
 */
import { api } from '../../api.js';
import { icon } from '../../utils/icons.js';
import { section, group, setReadOnly } from './ui.js';
import { readOnlyNotice } from './server.js';

export function transferSection() {
  const s = section({
    id: 'transfer',
    title: 'Move to another server',
    iconName: 'package',
    scope: 'server',
    intro: 'Take your whole Vault — media, folders, playlists, watch history, profiles and settings — to a new computer.',
  });

  const exportGroup = group('Take everything with you', {
    description: 'Makes one package from this server. Your files keep their exact folders and names, so you can also just open it and browse.',
  });
  exportGroup.dataset.keywords = 'export download backup zip copy migrate move transfer new computer server usb drive all files';
  const exportBody = document.createElement('div');
  exportGroup.append(exportBody);

  const importGroup = group('Import from another Vault', {
    description: 'Bring in a package made on your old server. Everything is relinked to this computer’s folders, then Vault restarts.',
  });
  importGroup.dataset.keywords = 'import restore upload migrate move transfer old computer server package';
  const importBody = document.createElement('div');
  importGroup.append(importBody);

  s.body.append(exportGroup, importGroup);

  // Built on first view: measuring a big library walks every file.
  let built = false;
  async function build() {
    if (built) return;
    built = true;
    const { mountExport, mountImport } = await import('../../components/transferPanel.js');
    mountExport(exportBody);
    mountImport(importBody, { setupMode: false });
    try {
      await api.transferSummary(false);
    } catch (err) {
      if (err.code === 'ADMIN_REQUIRED') {
        const message = await readOnlyNotice(err);
        setReadOnly(exportGroup, message);
        setReadOnly(importGroup);
      }
    }
  }
  const observer = new MutationObserver(() => { if (!s.hidden) build(); });
  observer.observe(s, { attributes: true, attributeFilter: ['hidden'] });
  // Visible straight away (deep link /settings#transfer) — the shell unhides
  // it right after building, which the observer catches.
  s.body.prepend(Object.assign(document.createElement('p'), {
    className: 'settings-callout is-info transfer-tip',
    innerHTML: `${icon('info', { size: 15 })}<span>Moving to a new computer: install Vault there first, then either download the package here and import it there, or open the new Vault’s setup wizard and choose <em>Import from another Vault</em>.</span>`,
  }));
  return s;
}

export default { transferSection };
