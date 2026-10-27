'use strict';

const $ = selector => document.querySelector(selector);
const REFRESH_MS = 30_000;
const UNITS_BY_BASE = { kg: ['kg', 'g', 'mg'], L: ['L', 'ml'], un: ['un'] };
// Unidade sugerida para fichas técnicas (porções costumam ser pequenas).
const RECIPE_DEFAULT_UNIT = { kg: 'g', L: 'ml', un: 'un' };
const ALL_UNITS = ['kg', 'g', 'mg', 'L', 'ml', 'un'];
const KIND = {
  entrada: { icon: '↗', label: 'Entrada', sign: '+', tone: 'ok' },
  preparo: { icon: '✓', label: 'Preparo', sign: '−', tone: 'info' },
  perda: { icon: '↓', label: 'Perda', sign: '−', tone: 'danger' },
  ajuste: { icon: '⇅', label: 'Ajuste', sign: '', tone: 'warn' },
};
const ALERTS = {
  vencido: { label: 'Lote vencido', tone: 'danger' },
  vence_hoje: { label: 'Vence hoje', tone: 'danger' },
  sem_estoque: { label: 'Sem estoque', tone: 'danger' },
  abaixo_do_minimo: { label: 'Abaixo do mínimo', tone: 'low' },
  vence_em_breve: { label: 'Vence em breve', tone: 'warn' },
};
const EXPIRY_LABEL = { vencido: 'Vencido', vence_hoje: 'Vence hoje', vence_em_breve: 'Vence em breve', ok: 'No prazo' };
const EXPIRY_TONE = { vencido: 'danger', vence_hoje: 'danger', vence_em_breve: 'warn', ok: 'ok' };
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const dateTime = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const clockTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

const state = { snapshot: null, loading: false, lotsIngredientId: null };
let toastTimer;

// ---------- utilitários ----------

/** Cria elementos com texto via textContent (dados nunca passam por innerHTML). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  } catch {
    // fetch só rejeita em falha de rede.
    throw new Error(
      navigator.onLine ? 'Não foi possível falar com o servidor. Tente de novo.' : 'Você está offline. Conecte-se e tente de novo.',
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a ação.');
  return data;
}
const send = (method, url, body) => api(url, { method, body: JSON.stringify(body ?? {}) });

function toast(message, tone = 'ok') {
  const element = $('#toast');
  element.textContent = message;
  element.dataset.tone = tone;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}

// "2026-03-10" -> "10/03/2026" sem passar por Date (evita deslocamento de fuso).
const formatDay = iso => (iso ? iso.split('-').reverse().join('/') : '—');
// SQLite grava CURRENT_TIMESTAMP em UTC: "AAAA-MM-DD HH:MM:SS".
const formatSqlDate = sql => dateTime.format(new Date(`${sql.replace(' ', 'T')}Z`));
const plural = (n, one, many) => `${number.format(n)} ${n === 1 ? one : many}`;

function relativeDays(days) {
  if (days === null || days === undefined) return '';
  if (days < -1) return `venceu há ${-days} dias`;
  if (days === -1) return 'venceu ontem';
  if (days === 0) return 'vence hoje';
  if (days === 1) return 'vence amanhã';
  return `em ${days} dias`;
}

/** Prévia em pt-BR; o servidor faz a conta exata em inteiros. */
function previewQuantity(value, unit) {
  if (unit === 'kg' && value < 1) return `${number.format(Math.round(value * 1e6) / 1e3)} g`;
  if (unit === 'L' && value < 1) return `${number.format(Math.round(value * 1e3))} ml`;
  return `${number.format(Math.round(value * 1e3) / 1e3)} ${unit}`;
}

function fillUnits(select, baseUnit, selected) {
  const units = baseUnit ? UNITS_BY_BASE[baseUnit] : ALL_UNITS;
  select.replaceChildren(...units.map(u => h('option', { value: u, text: u })));
  select.value = units.includes(selected) ? selected : units[0];
}

function setError(form, message) {
  form.querySelector('.form-error').textContent = message || '';
}

// Bloqueia o envio enquanto a requisição está em andamento (evita registro duplicado).
async function withSubmitLock(form, action) {
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  form.setAttribute('aria-busy', 'true');
  setError(form, '');
  try {
    await action();
  } catch (error) {
    setError(form, error.message);
  } finally {
    button.disabled = false;
    form.removeAttribute('aria-busy');
  }
}

function openDialog(dialog, focus) {
  dialog.querySelectorAll('.form-error').forEach(el => (el.textContent = ''));
  if (!dialog.open) dialog.showModal();
  (focus || dialog.querySelector('input, select, textarea, button:not([data-close])'))?.focus();
}

const findIngredient = id => state.snapshot?.inventory.find(item => item.id === id);

// ---------- dados ----------

function setSync(stateName, text) {
  const el = $('#sync-status');
  el.dataset.state = stateName;
  el.lastElementChild.textContent = text;
}

async function load({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!state.snapshot) renderLoading();
  setSync('loading', 'Atualizando…');
  try {
    state.snapshot = await api('/api/summary');
    render();
    setSync('ok', `Atualizado às ${clockTime.format(new Date())}`);
  } catch (error) {
    setSync('error', 'Sem conexão com o servidor');
    if (!state.snapshot) renderLoadError(error.message);
    else if (!quiet) toast(error.message, 'danger');
  } finally {
    state.loading = false;
  }
}

// ---------- renderização ----------

function stateRow(...children) {
  return h('tr', {}, h('td', { colspan: 5, class: 'state-cell' }, ...children));
}

function renderLoading() {
  $('#inventory').replaceChildren(stateRow(h('span', { class: 'spin', 'aria-hidden': 'true' }), ' Carregando estoque…'));
  $('#recipe-list').replaceChildren(h('li', { class: 'empty', text: 'Carregando receitas…' }));
  $('#activity-list').replaceChildren(h('li', { class: 'empty', text: 'Carregando atividade…' }));
}

function renderLoadError(message) {
  const retry = h('button', { type: 'button', class: 'button secondary', text: 'Tentar de novo' });
  retry.addEventListener('click', () => load());
  $('#inventory').replaceChildren(stateRow(h('p', { class: 'error-text', text: message }), retry));
  $('#recipe-list').replaceChildren(h('li', { class: 'empty', text: 'Não foi possível carregar as receitas.' }));
  $('#activity-list').replaceChildren(h('li', { class: 'empty', text: 'Não foi possível carregar a atividade.' }));
}

function renderHeader(data) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const [y, m, d] = data.today.split('-').map(Number);
  // "Hoje" vem do servidor (fuso do restaurante); meio-dia UTC evita virar o dia no navegador.
  const label = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  );
  $('#today-label').textContent = `${label} · visão geral`.toLocaleUpperCase('pt-BR');
  $('#greeting').textContent = `${greeting}, cozinha.`;
}

function renderMetrics(data) {
  $('#metric-items').textContent = data.inventory.length;
  $('#metric-expiring').textContent = data.expiringCount;
  $('#metric-expiring-label').textContent = `Vencem em ${data.warningDays} ${data.warningDays === 1 ? 'dia' : 'dias'}`;
  $('#metric-expiring-note').textContent = data.expiredCount
    ? `lotes · ${plural(data.expiredCount, 'vencido', 'vencidos')} para descartar`
    : 'lotes para priorizar no preparo';
  $('#metric-low').textContent = data.lowCount;
  $('#metric-waste').textContent = data.losses.count;
  $('#metric-waste-note').textContent = data.losses.byUnit.length
    ? data.losses.byUnit.map(u => u.label).join(' · ')
    : 'nenhuma perda registrada';
}

function renderAlerts(data) {
  const container = $('#alerts');
  const urgent = [];
  for (const item of data.inventory) {
    if (item.alerts.includes('vencido'))
      urgent.push({ item, tone: 'danger', text: `${item.name}: ${item.labels.expired} vencido — descartar` });
    else if (item.alerts.includes('vence_hoje'))
      urgent.push({ item, tone: 'danger', text: `${item.name}: lote vence hoje — use primeiro` });
    else if (item.alerts.includes('sem_estoque')) urgent.push({ item, tone: 'low', text: `${item.name}: sem estoque` });
    else if (item.alerts.includes('abaixo_do_minimo'))
      urgent.push({ item, tone: 'low', text: `${item.name}: ${item.labels.quantity} (mínimo ${item.labels.minimum})` });
  }
  container.hidden = urgent.length === 0;
  if (!urgent.length) return container.replaceChildren();
  const shown = urgent.slice(0, 6);
  container.replaceChildren(
    h(
      'h2',
      { class: 'alerts-title' },
      h('span', { class: 'alerts-mark', 'aria-hidden': 'true', text: '!' }),
      plural(urgent.length, 'alerta', 'alertas'),
    ),
    h(
      'ul',
      { class: 'alert-list' },
      shown.map(a =>
        h('li', {}, h('button', { type: 'button', class: `alert-chip tone-${a.tone}`, dataset: { lots: a.item.id }, text: a.text })),
      ),
      urgent.length > shown.length ? h('li', { class: 'alert-more', text: `+${urgent.length - shown.length}` }) : null,
    ),
  );
}

// Conteúdo embrulhado em um único bloco: no celular a célula vira grade rótulo/valor.
const cell = (label, ...children) => h('td', { 'data-label': label }, h('div', {}, ...children));
const badge = alert => h('span', { class: `badge tone-${ALERTS[alert].tone}`, text: ALERTS[alert].label });

function renderInventory(data) {
  const body = $('#inventory');
  if (!data.inventory.length) {
    const cta = h('button', { type: 'button', class: 'button primary', text: '+ Registrar a primeira entrada' });
    cta.addEventListener('click', () => openEntry());
    return body.replaceChildren(stateRow(h('p', { text: 'Nenhum ingrediente cadastrado ainda.' }), cta));
  }
  body.replaceChildren(
    ...data.inventory.map(item => {
      const expiry = item.nextExpiry
        ? [formatDay(item.nextExpiry), h('small', { class: 'cell-note', text: relativeDays(item.daysToExpiry) })]
        : [h('span', { class: 'muted', text: 'sem lote válido' })];
      const status = item.alerts.length ? item.alerts.map(badge) : [h('span', { class: 'badge tone-ok', text: 'Em dia' })];
      return h(
        'tr',
        { class: item.alerts.some(a => ALERTS[a].tone === 'danger') ? 'row-danger' : null },
        h('th', { scope: 'row', 'data-label': 'Ingrediente' }, item.name),
        cell(
          'Disponível',
          h('span', { class: 'qty', text: item.labels.quantity }),
          h('small', { class: 'cell-note', text: `mín. ${item.labels.minimum}` }),
        ),
        cell('Validade', ...expiry),
        cell('Situação', h('span', { class: 'badges' }, status)),
        h(
          'td',
          { class: 'row-actions' },
          h('button', {
            type: 'button',
            class: 'text-button',
            dataset: { lots: item.id },
            'aria-label': `Lotes de ${item.name}`,
            text: 'Lotes',
          }),
          h('button', {
            type: 'button',
            class: 'text-button danger',
            dataset: { waste: item.id },
            'aria-label': `Registrar perda de ${item.name}`,
            text: 'Perda',
          }),
        ),
      );
    }),
  );
}

function renderRecipes(data) {
  const list = $('#recipe-list');
  if (!data.recipes.length) {
    return list.replaceChildren(h('li', { class: 'empty', text: 'Nenhuma receita cadastrada ainda. Crie a primeira ficha técnica.' }));
  }
  list.replaceChildren(
    ...data.recipes.map(recipe => {
      const limiting = recipe.items.find(i => i.id === recipe.limitingIngredientId);
      return h(
        'li',
        { class: 'recipe' },
        h(
          'div',
          { class: 'recipe-top' },
          h('h3', { text: recipe.name }),
          h('span', { class: `recipe-count${recipe.portions ? '' : ' none'}`, text: plural(recipe.portions, 'porção', 'porções') }),
        ),
        h('p', { class: 'recipe-ingredients', text: recipe.items.map(i => `${i.name} ${i.labels.quantity}`).join(' · ') }),
        limiting && recipe.items.length > 1
          ? h('p', { class: 'cell-note', text: `Limitado por ${limiting.name} (${limiting.labels.available} disponível)` })
          : null,
        h('button', {
          type: 'button',
          class: 'text-button',
          dataset: { prepare: recipe.id },
          disabled: !recipe.portions,
          text: recipe.portions ? 'Preparar receita →' : 'Sem saldo para preparar',
        }),
      );
    }),
  );
}

function renderActivity(data) {
  const list = $('#activity-list');
  if (!data.movements.length) return list.replaceChildren(h('li', { class: 'empty', text: 'Nenhuma movimentação registrada.' }));
  list.replaceChildren(
    ...data.movements.map(m => {
      const kind = KIND[m.kind] || KIND.ajuste;
      const sign = m.kind === 'ajuste' ? (m.delta > 0 ? '+' : '−') : kind.sign;
      return h(
        'li',
        { class: 'movement' },
        h('span', { class: `move-icon tone-${kind.tone}`, 'aria-hidden': 'true', text: kind.icon }),
        h(
          'div',
          { class: 'move-main' },
          h('p', { class: 'move-name' }, h('span', { class: 'sr-only', text: `${kind.label}: ` }), m.name),
          h('p', { class: 'move-note', text: `${m.description} · ${formatSqlDate(m.createdAt)}` }),
        ),
        h('span', { class: `move-qty text-${kind.tone}`, text: `${sign}${m.label}` }),
      );
    }),
  );
}

function render() {
  const data = state.snapshot;
  renderHeader(data);
  renderMetrics(data);
  renderAlerts(data);
  renderInventory(data);
  renderRecipes(data);
  renderActivity(data);
  $('#ingredient-names').replaceChildren(...data.inventory.map(i => h('option', { value: i.name })));
}

// ---------- entrada ----------

function syncEntryUnits() {
  const name = $('#entry-name').value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
  const existing = state.snapshot?.inventory.find(i => i.name.toLocaleLowerCase('pt-BR') === name);
  const select = $('#entry-unit');
  fillUnits(select, existing?.unit, select.value);
  $('#entry-minimum').placeholder = existing ? `Atual: ${existing.labels.minimum}` : 'Ex.: 2';
  $('#entry-hint').textContent = existing
    ? `Já cadastrado em ${existing.unit}. Em branco, mantém o mínimo atual (${existing.labels.minimum}).`
    : 'Novo ingrediente. Mínimo na mesma unidade da quantidade; em branco, sem alerta de mínimo.';
}

function openEntry() {
  $('#entry-form').reset();
  fillUnits($('#entry-unit'), null, 'kg');
  syncEntryUnits();
  if (state.snapshot) $('#entry-expires').min = state.snapshot.today;
  openDialog($('#entry-dialog'), $('#entry-name'));
}

$('#entry-name').addEventListener('input', syncEntryUnits);
$('#entry-open').addEventListener('click', () => openEntry());
$('#entry-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  withSubmitLock(form, async () => {
    const data = Object.fromEntries(new FormData(form));
    if (!data.name.trim() || !data.quantity.trim() || !data.expiresOn) throw new Error('Preencha ingrediente, quantidade e validade.');
    if (!data.minimum.trim()) delete data.minimum;
    await send('POST', '/api/lots', data);
    $('#entry-dialog').close();
    toast(`Entrada de ${data.name.trim()} registrada.`);
    await load({ quiet: true });
  });
});

// ---------- receitas ----------

let recipeRowSeq = 0;
function addRecipeRow() {
  const index = ++recipeRowSeq;
  const select = h(
    'select',
    { name: 'ingredientId', id: `recipe-ingredient-${index}`, required: true },
    h('option', { value: '', text: 'Ingrediente…' }),
    (state.snapshot?.inventory ?? []).map(i => h('option', { value: i.id, text: i.name })),
  );
  const unit = h('select', { name: 'unit', 'aria-label': 'Unidade' });
  fillUnits(unit, null, 'g');
  select.addEventListener('change', () => {
    const item = findIngredient(Number(select.value));
    if (item) fillUnits(unit, item.unit, RECIPE_DEFAULT_UNIT[item.unit]);
  });
  const remove = h('button', { type: 'button', class: 'icon-button small', 'aria-label': 'Remover ingrediente', text: '×' });
  remove.addEventListener('click', () => {
    if ($('#recipe-rows').children.length > 1) remove.closest('.recipe-row').remove();
  });
  $('#recipe-rows').append(
    h(
      'div',
      { class: 'recipe-row' },
      h('label', { class: 'sr-only', for: select.id, text: 'Ingrediente' }),
      select,
      h('input', { name: 'quantity', inputmode: 'decimal', placeholder: 'Qtd.', 'aria-label': 'Quantidade por porção', required: true }),
      unit,
      remove,
    ),
  );
}

$('#recipe-open').addEventListener('click', () => {
  if (!state.snapshot?.inventory.length) return toast('Cadastre ingredientes com uma entrada antes de criar receitas.', 'warn');
  $('#recipe-form').reset();
  $('#recipe-rows').replaceChildren();
  addRecipeRow();
  addRecipeRow();
  openDialog($('#recipe-dialog'));
});
$('#recipe-add-row').addEventListener('click', () => {
  if ($('#recipe-rows').children.length >= 20) return toast('Uma receita aceita até 20 ingredientes.', 'warn');
  addRecipeRow();
  $('#recipe-rows').lastElementChild.querySelector('select').focus();
});
$('#recipe-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  withSubmitLock(form, async () => {
    const name = $('#recipe-name').value.trim();
    const items = [...$('#recipe-rows').children]
      .map(row => ({
        ingredientId: Number(row.querySelector('[name="ingredientId"]').value),
        quantity: row.querySelector('[name="quantity"]').value.trim(),
        unit: row.querySelector('[name="unit"]').value,
      }))
      .filter(item => item.ingredientId || item.quantity);
    if (!name) throw new Error('Informe o nome do prato.');
    if (!items.length || items.some(i => !i.ingredientId || !i.quantity))
      throw new Error('Escolha o ingrediente e a quantidade de cada linha.');
    await send('POST', '/api/recipes', { name, items });
    $('#recipe-dialog').close();
    toast(`Receita ${name} criada.`);
    await load({ quiet: true });
  });
});

// ---------- preparo ----------

function renderPreparePreview(recipe) {
  const portions = Math.max(0, Math.floor(Number($('#prepare-portions').value) || 0));
  $('#prepare-preview').replaceChildren(
    ...recipe.items.map(item => {
      const need = item.quantity * portions;
      const short = need > item.available * (1 + 1e-12);
      return h(
        'li',
        { class: short ? 'short' : null },
        h('span', { text: item.name }),
        h('strong', { text: `${previewQuantity(need, item.unit)} de ${item.labels.available}` }),
      );
    }),
  );
}

function openPrepare(id) {
  const recipe = state.snapshot.recipes.find(r => r.id === id);
  if (!recipe) return;
  const form = $('#prepare-form');
  form.reset();
  form.dataset.recipe = id;
  const input = $('#prepare-portions');
  input.max = String(Math.min(500, recipe.portions));
  input.value = '1';
  $('#prepare-title').textContent = recipe.name;
  $('#prepare-sub').textContent = `Dá para preparar até ${plural(recipe.portions, 'porção', 'porções')} com o saldo válido.`;
  input.oninput = () => renderPreparePreview(recipe);
  renderPreparePreview(recipe);
  openDialog($('#prepare-dialog'), input);
}

$('#recipe-list').addEventListener('click', event => {
  const button = event.target.closest('[data-prepare]');
  if (button) openPrepare(Number(button.dataset.prepare));
});
$('#prepare-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  withSubmitLock(form, async () => {
    const portions = Number($('#prepare-portions').value);
    if (!Number.isInteger(portions) || portions < 1) throw new Error('Informe um número inteiro de porções.');
    await send('POST', `/api/recipes/${form.dataset.recipe}/prepare`, { portions });
    $('#prepare-dialog').close();
    toast(`${plural(portions, 'porção baixada', 'porções baixadas')} do estoque.`);
    await load({ quiet: true });
  });
});

// ---------- perda ----------

function openWaste(id) {
  const item = findIngredient(id);
  if (!item) return;
  const form = $('#waste-form');
  form.reset();
  form.dataset.ingredient = id;
  $('#waste-title').textContent = `Perda · ${item.name}`;
  $('#waste-sub').textContent = `Disponível: ${item.labels.quantity}${item.expired ? ` · vencido: ${item.labels.expired}` : ''}.`;
  fillUnits($('#waste-unit'), item.unit, item.unit);
  if (item.expired) $('#waste-reason').value = 'Validade vencida';
  openDialog($('#waste-dialog'), $('#waste-quantity'));
}

$('#waste-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  withSubmitLock(form, async () => {
    const data = Object.fromEntries(new FormData(form));
    if (!data.quantity.trim()) throw new Error('Informe a quantidade perdida.');
    await send('POST', '/api/waste', { ingredientId: Number(form.dataset.ingredient), ...data });
    $('#waste-dialog').close();
    toast('Perda registrada para acompanhamento.');
    await load({ quiet: true });
  });
});

// ---------- lotes, mínimo e ajuste ----------

const lotsSummary = item =>
  `Disponível: ${item.labels.quantity} · mínimo: ${item.labels.minimum}${item.expired ? ` · vencido: ${item.labels.expired}` : ''}`;

async function loadLots(id) {
  const body = $('#lots-body');
  body.replaceChildren(h('p', { class: 'empty' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), ' Carregando lotes…'));
  try {
    const { ingredient, lots } = await api(`/api/ingredients/${id}/lots`);
    if (state.lotsIngredientId !== id) return;
    if (!lots.length) return body.replaceChildren(h('p', { class: 'empty', text: 'Nenhum lote com saldo.' }));
    body.replaceChildren(
      h(
        'ul',
        { class: 'lot-list' },
        lots.map(lot =>
          h(
            'li',
            { class: `lot border-${EXPIRY_TONE[lot.expiry]}` },
            h(
              'div',
              { class: 'lot-main' },
              h('strong', { text: lot.label }),
              h('small', {
                class: 'cell-note',
                text: `Lote #${lot.id} · validade ${formatDay(lot.expiresOn)} · ${relativeDays(lot.daysToExpiry)}`,
              }),
            ),
            h('span', { class: `badge tone-${EXPIRY_TONE[lot.expiry]}`, text: EXPIRY_LABEL[lot.expiry] }),
            h('button', {
              type: 'button',
              class: 'text-button danger',
              dataset: { discard: lot.id },
              'aria-label': `Descartar lote ${lot.id} de ${ingredient.name}`,
              text: 'Descartar',
            }),
          ),
        ),
      ),
    );
  } catch (error) {
    body.replaceChildren(h('p', { class: 'error-text', role: 'alert', text: error.message }));
  }
}

function openLots(id) {
  const item = findIngredient(id);
  if (!item) return;
  state.lotsIngredientId = id;
  $('#lots-title').textContent = item.name;
  $('#lots-sub').textContent = lotsSummary(item);
  $('#minimum-form').reset();
  $('#adjust-form').reset();
  fillUnits($('#minimum-unit'), item.unit, item.unit);
  fillUnits($('#adjust-unit'), item.unit, item.unit);
  $('#minimum-value').value = String(item.minimum).replace('.', ',');
  $('#adjust-expires').min = state.snapshot.today;
  openDialog($('#lots-dialog'), $('#lots-dialog .dialog-close'));
  loadLots(id);
}

async function refreshLots() {
  await load({ quiet: true });
  const item = findIngredient(state.lotsIngredientId);
  if (item && $('#lots-dialog').open) {
    $('#lots-sub').textContent = lotsSummary(item);
    await loadLots(item.id);
  }
}

$('#lots-body').addEventListener('click', async event => {
  const button = event.target.closest('[data-discard]');
  if (!button || button.disabled) return;
  // Confirmação em dois cliques, sem window.confirm.
  if (button.dataset.confirm !== 'yes') {
    button.dataset.confirm = 'yes';
    button.textContent = 'Confirmar descarte';
    return;
  }
  button.disabled = true;
  try {
    await send('POST', `/api/lots/${button.dataset.discard}/discard`, {});
    toast('Lote descartado e registrado como perda.');
    await refreshLots();
  } catch (error) {
    toast(error.message, 'danger');
    button.disabled = false;
  }
});

$('#minimum-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  withSubmitLock(form, async () => {
    const data = Object.fromEntries(new FormData(form));
    if (!data.minimum.trim()) throw new Error('Informe o mínimo (0 desativa o alerta).');
    await send('PATCH', `/api/ingredients/${state.lotsIngredientId}`, data);
    toast('Estoque mínimo atualizado.');
    await refreshLots();
  });
});

$('#adjust-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  withSubmitLock(form, async () => {
    const data = Object.fromEntries(new FormData(form));
    if (!data.counted.trim() || !data.reason.trim()) throw new Error('Informe o saldo contado e o motivo.');
    if (!data.expiresOn) delete data.expiresOn;
    const result = await send('POST', '/api/adjustments', { ingredientId: state.lotsIngredientId, ...data });
    form.reset();
    const item = findIngredient(state.lotsIngredientId);
    fillUnits($('#adjust-unit'), item?.unit, item?.unit);
    toast(`Ajuste registrado (${result.delta > 0 ? '+' : '−'}${previewQuantity(Math.abs(result.delta), result.unit)}).`);
    await refreshLots();
  });
});

// ---------- eventos globais ----------

document.addEventListener('click', event => {
  const lots = event.target.closest('[data-lots]');
  if (lots) return openLots(Number(lots.dataset.lots));
  const waste = event.target.closest('[data-waste]');
  if (waste) return openWaste(Number(waste.dataset.waste));
  const close = event.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
});

// Clique no fundo (fora do cartão) fecha o diálogo.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load({ quiet: true });
});
setInterval(() => {
  if (document.visibilityState === 'visible') load({ quiet: true });
}, REFRESH_MS);

load();
