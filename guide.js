import { KNOWLEDGE } from './knowledge.js';

const $ = (id) => document.getElementById(id);
const els = { search: $('search'), filters: $('filters'), content: $('content'), count: $('count'), expand: $('expand'), collapse: $('collapse') };
let activeFilter = 'all';

const collectibleTerms = ['maiamai','master ore','heart','bottle','mail','hylian shield','stamina scroll','upgrade','collectible'];
const bossTerms = ['boss','yuga','margomill','moldorm','stalblind','zaganaga','gemesaur','arrghus','knucklemaster','grinexx','dharkstare','ganon'];
const itemTerms = ['ravio','item','rod','bow','bomb','boomerang','hammer','hookshot','flippers','power glove','titan','bell','weather vane','wall merging','fissure','pegasus boots','fast travel'];

function bucket(entry) {
  const hay = `${entry.title} ${entry.tags.join(' ')}`.toLowerCase();
  if (collectibleTerms.some(x => hay.includes(x))) return 'collectibles';
  if (bossTerms.some(x => hay.includes(x))) return 'bosses';
  if (itemTerms.some(x => hay.includes(x))) return 'items';
  return 'walkthrough';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function matches(entry, q) {
  if (!q) return true;
  const hay = `${entry.title} ${entry.tags.join(' ')} ${entry.text}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every(word => hay.includes(word));
}

function render() {
  const q = els.search.value.trim().toLowerCase();
  const visible = KNOWLEDGE.map((entry, index) => ({...entry, index, bucket: bucket(entry)}))
    .filter(entry => (activeFilter === 'all' || entry.bucket === activeFilter) && matches(entry, q));

  els.count.textContent = `${visible.length} guide topic${visible.length === 1 ? '' : 's'} shown`;
  els.content.innerHTML = '';

  if (!visible.length) {
    els.content.innerHTML = '<div class="empty">No matching guide topics. Try a dungeon, boss, item or location name.</div>';
    return;
  }

  const labels = {
    walkthrough: 'Walkthrough & dungeons',
    bosses: 'Bosses',
    items: 'Items & travel',
    collectibles: 'Collectibles & upgrades'
  };

  const order = activeFilter === 'all' ? ['walkthrough','bosses','items','collectibles'] : [activeFilter];

  for (const group of order) {
    const items = visible.filter(x => x.bucket === group);
    if (!items.length) continue;
    const section = document.createElement('section');
    section.className = 'section';
    section.innerHTML = `<h2>${labels[group]}</h2>`;
    for (const entry of items) {
      const details = document.createElement('details');
      details.className = 'entry';
      details.dataset.index = entry.index;
      details.innerHTML = `<summary>${esc(entry.title)}</summary><div class="body">${esc(entry.text)}</div><div class="tags">${esc(entry.tags.join(' · '))}</div>`;
      section.appendChild(details);
    }
    els.content.appendChild(section);
  }
}

els.search.addEventListener('input', render);
els.filters.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  document.querySelectorAll('.filter').forEach(x => x.classList.toggle('active', x === btn));
  render();
});
els.expand.addEventListener('click', () => document.querySelectorAll('.entry').forEach(x => x.open = true));
els.collapse.addEventListener('click', () => document.querySelectorAll('.entry').forEach(x => x.open = false));

render();
