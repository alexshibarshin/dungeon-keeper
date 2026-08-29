import { useEffect, useMemo, useRef, useState } from 'react';
import { EXPAND_PRICES, HEART_HP, PERKS, STARTING_COINS, TRAPS } from './game/pivot/config';
import { generateDungeon } from './game/pivot/generator';
import type { PivotEngine } from './game/pivot/PivotEngine';
import type { DungeonStage, GameSnapshot, PerkDef, TrapId, TrapItem, TrapTag } from './game/pivot/types';

const emptyStats = { killed: 0, leaked: 0, damageTaken: 0, trapDamage: {}, wavesCleared: 0, rerolls: 0, expands: 0, recycled: 0 };
const emptySnapshot: GameSnapshot = {
  phase: 'prep', wave: 1, coins: STARTING_COINS, hp: HEART_HP, maxHp: HEART_HP, speed: 1, paused: false, enemyCount: 0,
  shop: [], hold: null, selectedPerks: [], perkChoices: [], rerollCost: 2, rerollFree: false, freeRerolls: 0,
  recyclerPoints: 0, recyclerTarget: 2, expandCost: EXPAND_PRICES[0], expandCount: 0, activeEntrances: [],
  preview: { grunt: 0, runner: 0, flyer: 0, shieldbearer: 0, brute: 0 }, dragging: null, dragZoneBonus: 0,
  message: '', enemyHint: null, recycleConfirm: null, shopTransitioning: false, stats: emptyStats, victory: null,
};

function CoinIcon({ small = false }: { small?: boolean }) {
  return <svg className={`coin-icon ${small ? 'small' : ''}`} viewBox="0 0 40 40" aria-hidden="true">
    <circle cx="20" cy="20" r="17" fill="#76501f" stroke="#fff3a6" strokeWidth="3" />
    <circle cx="20" cy="20" r="13" fill="#ffd84e" stroke="#d68a1e" strokeWidth="3" />
    <path d="M21.8 8.5 14 19.3h5.1l-1 12.2L26 19.7h-5.1z" fill="#fff6aa" stroke="#8c5518" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>;
}

function TrapFigure({ item, compact = false }: { item: TrapItem; compact?: boolean }) {
  const def = TRAPS[item.trapId];
  const maxX = Math.max(...def.shape.map(point => point.x)), maxY = Math.max(...def.shape.map(point => point.y));
  const occupied = new Set(def.shape.map(point => `${point.x},${point.y}`));
  const links = def.shape.flatMap(point => ([{ dx: 1, dy: 0, kind: 'horizontal' }, { dx: 0, dy: 1, kind: 'vertical' }] as const)
    .filter(edge => occupied.has(`${point.x + edge.dx},${point.y + edge.dy}`))
    .map(edge => ({ x: point.x, y: point.y, kind: edge.kind })));
  return <span className={`trap-figure tier-${item.tier} ${compact ? 'compact' : ''}`} style={{ '--shape-w': maxX + 1, '--shape-h': maxY + 1, '--trap-accent': `#${def.accent.toString(16).padStart(6, '0')}` } as React.CSSProperties}>
    {links.map((link, index) => <i key={`link-${index}`} className={`trap-link ${link.kind}`} style={{ '--cell-x': link.x, '--cell-y': link.y } as React.CSSProperties} />)}
    <img className="trap-silhouette" src={`/assets/traps/${def.assetId}.png`} alt="" />
    {def.shape.map((point, index) => <span className="trap-cell" key={index} style={{ '--cell-x': point.x, '--cell-y': point.y } as React.CSSProperties} />)}
    {item.tier > 1 && <span className="trap-stars" aria-label={`Tier ${item.tier}`}>{Array.from({ length: item.tier }).map((_, index) => <i key={index}>★</i>)}</span>}
  </span>;
}

function DragTooltip({ item, engine }: { item: TrapItem; engine: PivotEngine }) {
  const def = TRAPS[item.trapId], zone = def.zone, dragOrigin = engine.drag?.boardOrigin ?? item.origin;
  const matches = engine.zoneMatchCount(item, dragOrigin), damage = Math.round(engine.getItemDamage(item, dragOrigin));
  const damageModifier = Math.round((engine.getItemDamage(item, dragOrigin) / def.damage - 1) * 100);
  const area = Math.round(engine.getItemArea(item, dragOrigin)), range = Math.round(engine.getItemRange(item, dragOrigin));
  const cooldown = engine.getItemCooldown(item).toFixed(1), perkCount = engine.trapPerkCount(item);
  const tags: TrapTag[] = [def.element, ...(def.family ? [def.family] : [])];
  const tierZone = { 1: 1, 2: 1.5, 3: 2 }[item.tier];
  return <aside className="drag-tooltip" aria-label={`${def.name} details`}>
    <TrapFigure item={item} compact />
    <div className="tooltip-copy">
      <div className="tooltip-title"><span className={`element-dot ${def.element?.toLowerCase() ?? 'physical'}`} /><b>{def.name}</b><small className="target-rule">{def.canTargetFlying ? 'GROUND + FLYING' : 'GROUND ONLY'}</small><em>T{item.tier}</em></div>
      <div className="stat-line"><span className={damageModifier > 0 ? 'zone-boosted' : ''}>⚔ <b>{damage}</b>{damageModifier > 0 && <small>+{damageModifier}%</small>}</span><span>◴ <b>{cooldown}s</b></span>{def.area > 0 && <span className={matches && zone?.areaPerCell ? 'zone-boosted' : ''}>◎ <b>{area}</b></span>}{def.range > 0 && <span className={matches && zone?.rangePerCell ? 'zone-boosted' : ''}>↗ <b>{range}</b></span>}<span className="perk-count">✦ ×{perkCount}</span></div>
      <div className="tag-line">{tags.map(tag => <i key={tag} className={`tag tag-${tag.toLowerCase()}`}>{tag}</i>)}</div>
      {zone ? <div className="zone-formula"><strong>+{Math.round(zone.damagePerCell * 100 * tierZone)}% {zone.areaPerCell ? 'Area and DMG' : zone.rangePerCell ? 'Range and DMG' : 'DMG'}</strong> per <b>[{zone.checks}]</b> in the <i /> zone <span>{matches > 0 ? `×${matches}` : ''}</span></div> : <div className="zone-formula muted">Independent enabler · no zone bonus</div>}
    </div>
  </aside>;
}

const rarityLabel = { rare: 'Rare', epic: 'Epic', legendary: 'Legendary' } as const;

function trapIdsForPerk(perk: PerkDef): TrapId[] {
  return (Object.keys(TRAPS) as TrapId[]).filter(id => {
    const def = TRAPS[id], scope = perk.scope;
    return scope.element === def.element;
  });
}

function PerkArt({ perk }: { perk: PerkDef }) {
  const ids = trapIdsForPerk(perk).slice(0, 2);
  return <div className="perk-art">{ids.map((id, index) => <img key={id} src={`/assets/traps/${TRAPS[id].assetId}.png`} alt={TRAPS[id].name} style={{ '--art-index': index, '--art-total': ids.length } as React.CSSProperties} />)}</div>;
}

function tagForPerk(perk: PerkDef): TrapTag { return perk.scope.element; }

function TagPopover({ tag, onClose }: { tag: TrapTag; onClose: () => void }) {
  const ids = (Object.keys(TRAPS) as TrapId[]).filter(id => {
    const def = TRAPS[id]; return def.element === tag || def.family === tag;
  });
  return <div className="tag-popover-backdrop" onClick={onClose}><div className="tag-popover" onClick={event => event.stopPropagation()}><b>[{tag}]</b><div>{ids.map(id => <span key={id}><img src={`/assets/traps/${TRAPS[id].assetId}.png`} alt={TRAPS[id].name} /></span>)}</div></div></div>;
}

function PerkCard({ perk, affected, onChoose, onTag, flying }: { perk: PerkDef; affected: number; onChoose: () => void; onTag: (tag: TrapTag) => void; flying: boolean }) {
  const tag = tagForPerk(perk);
  return <article className={`perk-card rarity-${perk.rarity} ${flying ? 'chosen-fly' : ''}`} role="button" tabIndex={0} onClick={onChoose} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onChoose(); } }}>
    <div className="perk-name"><b>{perk.name}</b><span>{rarityLabel[perk.rarity]}</span></div><PerkArt perk={perk} />
    <div className="perk-effect">{tag && <button onClick={event => { event.stopPropagation(); onTag(tag); }}>[{tag}]</button>}<strong>{perk.text.replace(`[${tag}]`, '').trim()}</strong></div>
    <small>Affected Traps: <b>{affected}</b></small>
  </article>;
}

function PerkChoice({ snapshot, engine }: { snapshot: GameSnapshot; engine: PivotEngine }) {
  const [tag, setTag] = useState<TrapTag | null>(null), [flying, setFlying] = useState<string | null>(null);
  const choose = (id: string) => { if (flying) return; setFlying(id); window.setTimeout(() => engine.choosePerk(id), 360); };
  return <div className="overlay perk-choice"><header><small>WAVE {snapshot.wave} CLEARED</small><h2>Choose Your Power</h2></header><div className="perk-choice-grid">{snapshot.perkChoices.map(perk => <PerkCard key={perk.id} perk={perk} affected={engine.affectedCount(perk)} flying={flying === perk.id} onChoose={() => choose(perk.id)} onTag={setTag} />)}</div>{tag && <TagPopover tag={tag} onClose={() => setTag(null)} />}</div>;
}

function PerkDeck({ snapshot, onClose }: { snapshot: GameSnapshot; onClose: () => void }) {
  const perks = snapshot.selectedPerks.map(id => PERKS.find(perk => perk.id === id)).filter((perk): perk is PerkDef => !!perk);
  return <div className="overlay deck-overlay"><button className="round-close" onClick={onClose}>×</button><header><small>CURRENT RUN</small><h2>Your Build</h2><p>{perks.length}/9 perks</p></header><div className="deck-cards">{perks.length ? perks.map(perk => <div className={`mini-perk rarity-${perk.rarity}`} key={perk.id}><PerkArt perk={perk} /><b>{perk.name}</b><small>{perk.text}</small></div>) : <div className="empty-build">Your first perk arrives after Wave 1.</div>}</div></div>;
}

function StageIntro({ stage, ready, onEnter }: { stage: DungeonStage; ready: boolean; onEnter: () => void }) {
  return <div className="overlay stage-intro"><div className="intro-card"><small>NEW DUNGEON · {stage.archetype}</small><h1>{stage.name}</h1><p>{stage.tagline}</p><div className="intro-icons"><span>10<br /><small>WAVES</small></span><span>8×12<br /><small>ARENA</small></span><span>{stage.finalEntrances.length}<br /><small>PORTALS</small></span></div><button className="battle-button" disabled={!ready} onClick={onEnter}>{ready ? 'Enter Dungeon' : 'Preparing Dungeon…'}</button></div></div>;
}

function Result({ snapshot, engine, onNew }: { snapshot: GameSnapshot; engine: PivotEngine; onNew: () => void }) {
  const top = Object.entries(snapshot.stats.trapDamage).sort((a, b) => b[1] - a[1])[0];
  return <div className="overlay result-overlay"><div className="result-card"><div className="result-seal">{snapshot.victory ? '✦' : '♥'}</div><small>{snapshot.victory ? 'DUNGEON SECURED' : `WAVE ${snapshot.wave}/10`}</small><h2>{snapshot.victory ? 'Victory' : 'Heart Shattered'}</h2><div className="result-stats"><span><b>{snapshot.stats.killed}</b><small>DEFEATED</small></span><span><b>{snapshot.stats.leaked}</b><small>LEAKED</small></span><span><b>{snapshot.hp}</b><small>HEART</small></span></div>{top && <div className="top-trap"><img src={`/assets/traps/${TRAPS[top[0] as TrapId].assetId}.png`} alt="" /><span><small>TOP TRAP</small><b>{TRAPS[top[0] as TrapId].name}</b><em>{Math.round(top[1])} DMG</em></span></div>}<button className="battle-button" onClick={() => engine.retry()}>Retry</button><button className="secondary-action" onClick={onNew}>New Dungeon</button></div></div>;
}

const enemyCopy = {
  grunt: 'Reliable melee invader.', runner: 'Fast and difficult to cover.', flyer: 'Only targeting traps can hit it.',
  shieldbearer: 'High HP and steady advance.', brute: 'Massive HP and heavy Heart damage.',
} as const;

function EnemyHint({ kind, engine }: { kind: keyof typeof enemyCopy; engine: PivotEngine }) {
  const def = engine.enemyDefinition(kind);
  return <aside className="enemy-hint" aria-label={`${def.name} details`}>
    <img src={`/assets/enemies/${engine.enemyAssetName(kind)}-sheet-v2.png`} alt="" />
    <div><b>{def.name}</b><span>{enemyCopy[kind]}</span></div>
    <em>♥ {def.heartDamage}</em><button onClick={() => engine.closeEnemyHint()}>×</button>
  </aside>;
}

function RecycleConfirm({ item, engine }: { item: TrapItem; engine: PivotEngine }) {
  return <div className="confirm-backdrop"><section className="confirm-card"><TrapFigure item={item} compact /><small>RECYCLE T{item.tier} TRAP?</small><h3>{TRAPS[item.trapId].name}</h3><p>Higher-tier traps still grant only one Recycler point.</p><div><button className="secondary-action" onClick={() => engine.cancelRecycle()}>Keep</button><button className="danger-action" onClick={() => engine.confirmRecycle()}>Recycle</button></div></section></div>;
}

function Game({ seed, onNew }: { seed: number; onNew: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null), engineRef = useRef<PivotEngine | null>(null), pausedBeforeDeck = useRef(false);
  const [snapshot, setSnapshot] = useState(emptySnapshot), [intro, setIntro] = useState(true), [deckOpen, setDeckOpen] = useState(false);
  const stage = useMemo(() => generateDungeon(seed), [seed]);
  useEffect(() => {
    let cancelled = false, mountedEngine: PivotEngine | null = null;
    void import('./game/pivot/PivotEngine').then(({ PivotEngine: Engine }) => {
      if (cancelled) return;
      mountedEngine = new Engine(seed, setSnapshot, stage); engineRef.current = mountedEngine;
      if (hostRef.current) void mountedEngine.mount(hostRef.current);
    });
    return () => { cancelled = true; mountedEngine?.destroy(); engineRef.current = null; };
  }, [seed, stage]);
  const engine = engineRef.current;
  const waveTotal = Object.values(snapshot.preview).reduce((sum, count) => sum + count, 0);
  const defeatedThisWave = Math.max(0, waveTotal - snapshot.enemyCount);
  const openDeck = () => { if (!engine) return; pausedBeforeDeck.current = snapshot.paused; engine.pauseForOverlay(true); setDeckOpen(true); };
  const closeDeck = () => { setDeckOpen(false); engine?.pauseForOverlay(pausedBeforeDeck.current); };
  return <section className={`game-frame phase-${snapshot.phase}`}><div className="pixi-host" ref={hostRef} />
    {snapshot.dragging && engine ? <DragTooltip item={snapshot.dragging} engine={engine} /> : <header className="top-hud"><div className="stage-chip"><small>{stage.archetype}</small><b>Wave {snapshot.wave}<i>/10</i></b></div><div className="heart-meter"><span>♥</span><div><small>HEART</small><i><b style={{ width: `${snapshot.hp / snapshot.maxHp * 100}%` }} /></i><em>{snapshot.hp}/{snapshot.maxHp}</em></div></div>{snapshot.phase === 'combat' && <div className="coin-counter"><CoinIcon small /><b>{snapshot.coins}</b></div>}<button className="deck-button" onClick={openDeck}><span>✦</span><b>{snapshot.selectedPerks.length}</b></button>{snapshot.phase === 'combat' && <div className="top-combat-controls"><button onClick={() => engine?.togglePause()}>{snapshot.paused ? '▶' : 'Ⅱ'}</button><button onClick={() => engine?.toggleSpeed()}>×{snapshot.speed}</button></div>}</header>}
    {(snapshot.phase === 'prep' || snapshot.shopTransitioning) && <div className={`prep-economy ${snapshot.phase !== 'prep' ? 'leaving' : ''}`}><div className={`recycler-counter ${snapshot.rerollFree ? 'ready' : ''}`}><small>RECYCLE</small><b>{snapshot.recyclerPoints}/{snapshot.recyclerTarget}</b>{snapshot.rerollFree && <span>FREE ×{snapshot.freeRerolls}</span>}</div><div className="prep-wallet" aria-label={`${snapshot.coins} coins`}><CoinIcon /><b>{snapshot.coins}</b></div></div>}
    {(snapshot.phase === 'prep' || snapshot.shopTransitioning) && <div className={`prep-actions ${snapshot.phase !== 'prep' ? 'leaving' : ''}`}><div className="action-wrap"><button className="expand-button" disabled={snapshot.phase !== 'prep' || !engine || snapshot.expandCost == null || snapshot.coins < snapshot.expandCost} onClick={() => engine?.expand()}><span>Expand</span><small>{snapshot.expandCost == null ? 'MAX' : <><CoinIcon small />{snapshot.expandCost}</>}</small></button></div><button className={`reroll-button ${snapshot.rerollFree ? 'free' : ''}`} disabled={snapshot.phase !== 'prep' || !engine || (!snapshot.rerollFree && snapshot.coins < snapshot.rerollCost)} onClick={() => engine?.reroll()}><span>Reroll</span><small>{snapshot.rerollFree ? `FREE ×${snapshot.freeRerolls}` : <><CoinIcon small />{snapshot.rerollCost}</>}</small></button><button className="battle-button" disabled={snapshot.phase !== 'prep' || !engine} onClick={() => engine?.battle()}>Battle!</button></div>}
    {snapshot.phase === 'combat' && <div className="combat-progress" aria-live="polite"><div><small>HORDE IN MOTION</small><b>{snapshot.enemyCount} remaining</b></div><i><b style={{ width: `${waveTotal ? defeatedThisWave / waveTotal * 100 : 0}%` }} /></i><span>{snapshot.activeEntrances.length} {snapshot.activeEntrances.length === 1 ? 'stream' : 'streams'} converging on the Heart</span></div>}
    {snapshot.phase === 'prep' && engine?.boardItems.length === 0 && !snapshot.dragging && <div className="first-placement-hint"><span>↥</span><b>Drag a trap onto the glowing floor</b></div>}
    {snapshot.message && snapshot.phase === 'prep' && <div className="toast">{snapshot.message}</div>}
    {snapshot.enemyHint && engine && <EnemyHint kind={snapshot.enemyHint} engine={engine} />}
    {snapshot.recycleConfirm && engine && <RecycleConfirm item={snapshot.recycleConfirm} engine={engine} />}
    {intro && <StageIntro stage={stage} ready={!!engine && snapshot.activeEntrances.length > 0} onEnter={() => setIntro(false)} />}{snapshot.phase === 'perk' && engine && <PerkChoice snapshot={snapshot} engine={engine} />}{deckOpen && <PerkDeck snapshot={snapshot} onClose={closeDeck} />}{snapshot.phase === 'result' && engine && <Result snapshot={snapshot} engine={engine} onNew={onNew} />}
  </section>;
}

export default function App() { const [seed, setSeed] = useState(() => Math.floor(100000 + Math.random() * 899999)); return <main className="app-shell"><Game key={seed} seed={seed} onNew={() => setSeed(Math.floor(100000 + Math.random() * 899999))} /></main>; }
