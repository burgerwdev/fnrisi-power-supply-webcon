// Settings tab: app settings form + recipe (localStorage) manager.
import type { DeviceController } from '../../device/controller';
import {
  deleteRecipe,
  defaultRecipe,
  getRecipe,
  listRecipes,
  putRecipe,
  saveSettings,
  undoRecipeOp,
  type AppSettings,
} from '../../storage/settings';
import { h, on } from '../../ui/dom';
import { currentLang, setLang, t } from '../../i18n';
import { confirmDialog } from '../../ui/confirm';

export function initSettingsTab(
  root: HTMLElement,
  device: DeviceController,
  getSettings: () => AppSettings,
  applyTheme: (t: 'dark' | 'light') => void,
  onChange: () => void,
  reload: () => void,
): void {
  root.textContent = '';
  root.append(h('h2', {}, t('page.settings')));
  let settings = getSettings();
  root.append(
    section(t('set.sec.app'), settingsForm()),
    section(t('set.sec.info'), deviceInfoPanel()),
    section(t('set.sec.config'), recipePanel()),
    section(t('set.sec.about'), h('div', { class: 'notice' },
      t('set.about'))),
  );

  function deviceInfoPanel(): HTMLElement {
    const box = h('div', { class: 'notice', style: 'line-height:1.8' }, t('set.info.notconn'));
    const render = (): void => {
      const st = device.getState();
      if (!st.connected) {
        box.textContent = t('set.info.notconnHint');
        return;
      }
      const i = st.info;
      const tel = st.telemetry;
      box.textContent =
        t('set.info.model').replace('{m}', i.modelName ?? '--').replace('{h}', i.hwVersion ?? '--').replace('{f}', i.fwVersion ?? '--') + '\n' +
        t('set.info.line2').replace('{vin}', tel.inputVoltage?.toFixed(2) ?? '--').replace('{vm}', st.limits.maxVoltage?.toFixed(2) ?? '--').replace('{am}', st.limits.maxCurrent?.toFixed(3) ?? '--').replace('{pm}', st.telemetryPeriodMs ? '≈' + st.telemetryPeriodMs + ' ms' : '--') + '\n' +
        t('set.info.state').replace('{o}', st.status.output).replace('{m}', st.status.mode).replace('{p}', st.status.protection);
    };
    device.on('state', render);
    device.on('telemetry', render);
    render();
    const copy = h('button', {}, t('set.copyDiag'));
    on(copy, 'click', async () => {
      const txt = `# DPS-150 诊断 ${new Date().toISOString()}\n` +
        `settings=${JSON.stringify(getSettings(), null, 2)}\n` +
        `recipes=${JSON.stringify(listRecipes(), null, 2)}\n` +
        `device=${JSON.stringify({ state: device.getState(), connected: device.isOpen() }, null, 2)}`;
      try {
        await navigator.clipboard.writeText(txt);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = txt;
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      box.textContent = t('set.copied');
    });
    return h('div', {}, box, h('div', { class: 'row' }, copy));
  }

  function section(title: string, body: HTMLElement): HTMLElement {
    return h('section', { class: 'panel' }, h('h2', {}, title), body);
  }

  function commit(): void {
    settings = { ...getSettings(), ...settings };
    saveSettings(settings);
    onChange();
  }

  function settingsForm(): HTMLElement {
    const theme = h('select', {},
      h('option', { value: 'dark', selected: settings.theme === 'dark' }, t('set.themeDark')),
      h('option', { value: 'light', selected: settings.theme === 'light' }, t('set.themeLight')));
    on(theme, 'change', () => {
      settings.theme = theme.value as 'dark' | 'light';
      applyTheme(settings.theme);
      commit();
    });

    const baud = h('select', {},
      ...[9600, 19200, 38400, 57600, 115200].map((b) =>
        h('option', { value: String(b), selected: settings.baud === b }, String(b))));
    on(baud, 'change', () => {
      settings.baud = Number(baud.value);
      commit();
    });

    const period = h('select', { id: 'st-period', title: t('set.rateTitle') },
      h('option', { value: '0', selected: settings.samplePeriodMs === 0 }, t('set.rateFastest')),
      ...[500, 1000, 2000, 5000].map((p) => h('option', { value: String(p), selected: settings.samplePeriodMs === p }, `${p} ms`)),
      h('option', { value: '-1', selected: settings.samplePeriodMs === -1 }, t('rec.adaptive')));
    on(period, 'change', () => {
      settings.samplePeriodMs = Number(period.value);
      commit();
    });

    const cap = h('input', { type: 'number', min: '1000', step: '1000', value: String(settings.sessionCapPoints), style: 'width:140px', title: t('set.cap.title') }) as HTMLInputElement;
    on(cap, 'change', () => {
      const n = Number(cap.value);
      if (n >= 1000) {
        settings.sessionCapPoints = Math.floor(n);
        commit();
      }
    });

    const confirmD = h('input', { type: 'checkbox' }) as HTMLInputElement;
    confirmD.checked = settings.confirmDanger;
    on(confirmD, 'change', () => {
      settings.confirmDanger = confirmD.checked;
      commit();
    });

    const interrupt = h('select', {},
      h('option', { value: 'prompt', selected: settings.autoRunInterrupt === 'prompt' }, t('set.autoPrompt')),
      h('option', { value: 'pause', selected: settings.autoRunInterrupt === 'pause' }, t('set.autoPause')),
      h('option', { value: 'stop', selected: settings.autoRunInterrupt === 'stop' }, t('set.autoStop')));
    on(interrupt, 'change', () => {
      settings.autoRunInterrupt = interrupt.value as AppSettings['autoRunInterrupt'];
      commit();
    });

    const now = currentLang();
    const lang = h('select', { title: t('set.langTitle') },
      h('option', { value: 'zh', selected: now === 'zh' }, t('set.langZh')),
      h('option', { value: 'en', selected: now === 'en' }, 'English'));
    on(lang, 'change', () => {
      setLang(lang.value === 'en' ? 'en' : 'zh');
      location.reload();
    });

    const reloadBtn = h('button', { class: 'danger' }, t('set.reset'));
    on(reloadBtn, 'click', async () => {
      const ok = await confirmDialog({
        title: t('set.reset.title'),
        body: t('set.reset.body'),
        okText: t('set.reset.ok'),
        danger: true,
      });
      if (!ok) return;
      localStorage.removeItem('dps150.settings.v1');
      reload();
    });

    return h('div', {},
      row(t('set.theme'), theme),
      row(t('set.lang'), lang),
      row(t('set.baud'), baud),
      row(t('set.rate'), period),
      row(t('set.cap'), cap),
      row(t('set.confirm'), confirmD),
      row(t('set.interrupt'), interrupt),
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), reloadBtn),
    );
  }

  function recipePanel(): HTMLElement {
    const listEl = h('div', {});
    const name = h('input', { type: 'text', placeholder: t('config.namePlaceholder'), style: 'width:180px' }) as HTMLInputElement;
    const fromDevice = h('button', { class: 'primary' }, t('config.new'));
    const loadDef = h('button', {}, t('config.default'));
    const undo = h('button', {}, t('config.undo'));

    const render = async (): Promise<void> => {
      listEl.textContent = '';
      const items = listRecipes();
      if (!items.length) {
        listEl.append(h('div', { class: 'notice' }, t('config.empty')));
        return;
      }
      for (const it of items) listEl.append(recipeRow(it.name, render));
    };

    on(fromDevice, 'click', async () => {
      const nm = name.value.trim();
      if (!nm) {
        await confirmDialog({ title: t('config.missingName.title'), body: t('config.missingName.body'), okText: t('config.ok') });
        return;
      }
      const s = device.getState();
      if (!device.isOpen()) {
        await confirmDialog({ title: t('config.notconn.title'), body: t('config.notconn.body'), okText: t('config.ok') });
        return;
      }
      const r = defaultRecipe(nm);
      r.presets = s.presets.map((p) => ({ voltage: p.voltage, current: p.current }));
      r.protections = { ...r.protections, ...s.protections };
      if (s.settings.brightness !== undefined) r.brightness = s.settings.brightness;
      if (s.settings.volume !== undefined) r.volume = s.settings.volume;
      putRecipe(r);
      name.value = '';
      await render();
      await confirmDialog({ title: t('config.saved'), body: t('config.savedDone').replace('{n}', nm), okText: t('config.ok') });
    });

    on(loadDef, 'click', async () => {
      const ok = await confirmDialog({
        title: t('config.overwrite.title'),
        body: t('config.overwrite.body'),
        okText: t('config.overwrite.ok'),
        danger: true,
      });
      if (ok) {
        putRecipe(defaultRecipe('default'));
        await render();
      }
    });

    on(undo, 'click', async () => {
      const r = undoRecipeOp();
      if (!r) {
        await confirmDialog({ title: t('config.noUndo.title'), body: t('config.noUndo.body'), okText: t('config.ok') });
      } else {
        await confirmDialog({ title: t('config.undone.title'), body: t('config.undone.body').replace('{n}', r.name), okText: t('config.ok') });
      }
      await render();
    });

    function recipeRow(nm: string, refresh: () => void): HTMLElement {
      const rec = getRecipe(nm);
      const info = h('span', { class: 'notice', style: 'flex:1' },
        `${nm} · ${rec ? `${rec.presets[0].voltage.toFixed(1)}V/… ` : ''}${rec ? new Date(rec.updatedAt).toLocaleString() : ''}`);
      const apply = h('button', { class: 'primary' }, t('config.apply'));
      const del = h('button', { class: 'danger' }, t('config.delete'));
      on(apply, 'click', async () => {
        if (!rec) return;
        const ok = await confirmDialog({
          title: t('config.applyTitle').replace('{n}', nm),
          body: t('config.apply.body'),
          okText: t('config.apply.ok'),
          danger: true,
        });
        if (!ok) return;
        for (let i = 0; i < 6; i++) await device.setPreset(i + 1, rec.presets[i]?.voltage ?? 0, rec.presets[i]?.current ?? 0);
        if (rec.protections.ovp !== undefined) await device.setProtection(0xd1, rec.protections.ovp);
        if (rec.protections.ocp !== undefined) await device.setProtection(0xd2, rec.protections.ocp);
        if (rec.protections.opp !== undefined) await device.setProtection(0xd3, rec.protections.opp);
        if (rec.protections.otp !== undefined) await device.setProtection(0xd4, rec.protections.otp);
        if (rec.protections.lvp !== undefined) await device.setProtection(0xd5, rec.protections.lvp);
        if (rec.brightness !== undefined) await device.setBrightness(rec.brightness);
        if (rec.volume !== undefined) await device.setVolume(rec.volume);
        await device.refreshSnapshot();
      });
      on(del, 'click', async () => {
        const ok = await confirmDialog({ title: t('config.delete.title'), body: t('config.delete.body').replace('{n}', nm), okText: t('config.delete'), danger: true });
        if (ok) {
          deleteRecipe(nm);
          refresh();
        }
      });
      return h('div', { class: 'row', style: 'border-bottom:1px solid var(--border-soft)' }, info, apply, del);
    }

    void render();
    return h('div', {},
      h('div', { class: 'row' }, name, fromDevice, loadDef, undo),
      listEl,
    );
  }

  function row(label: string, control: HTMLElement): HTMLElement {
    return h('div', { class: 'row' }, h('label', { style: 'min-width:220px' }, label), control);
  }
}
