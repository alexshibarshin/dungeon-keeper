import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_DECK, ENEMIES, STARTING_COINS, trapUpgradePrice, TRAPS } from './game/config';
import type { GameEngine } from './game/GameEngine';
import { generateStage, wavePreview } from './game/rules';
import type { EnemyKind, GameSnapshot, TrapDef, TrapOffer } from './game/types';

const emptySnapshot: GameSnapshot = {
  phase: 'prep', wave: 1, coins: STARTING_COINS, hp: 100, maxHp: 100, heartLevel: 1, speed: 1, enemyCount: 0,
  offers: [], selectedOffer: null, selectedTrap: null, terrainMode: null, moveMode: false, movingTrap: null, message: '', activeEntrances: 1,
  preview: { delver: 0, runner: 0, brute: 0, shield: 0, wing: 0 }, perks: [], perkChoices: [],
  stats: { killed: 0, pitKills: 0, leaked: 0, damageTaken: 0, reactionCount: {}, reactionDamage: {}, primerCount: {}, triggerCount: {}, burnDamage: {}, trapDamage: {}, trapLevels: {}, heartDamage: 0, maxHeartLevel: 1, builtWalls: 0, digs: 0, spentTraps: 0, spentUpgrades: 0, spentHeart: 0, spentRepair: 0, spentReroll: 0, spentTerrain: 0, wavesCleared: 0 }, stars: 0,
};

const ENEMY_HINTS: Record<EnemyKind, { danger: string; counter: string; mark: string }> = {
  delver: { danger: 'Основная масса. Слаб поодиночке, опасен плотностью.', counter: 'Крупные напольные ловушки и урон по площади.', mark: 'М' },
  runner: { danger: 'Быстро проскакивает редкие срабатывания.', counter: 'Замедление, непрерывный урон и длинные зоны.', mark: 'Б' },
  brute: { danger: 'Много здоровья и большая масса. Плохо отталкивается.', counter: 'Реакции, огонь и длительный фокус базы.', mark: 'Т' },
  shield: { danger: 'Снижает обычный урон, пока не получил элемент.', counter: 'Сначала наложи ауру, затем запусти реакцию.', mark: 'Щ' },
  wing: { danger: 'Летит над полом, пропастями и напольными ловушками.', counter: 'Настенные ловушки и стрелки Dungeon Heart.', mark: 'К' },
};

function MiniMap({ grid, large = false }: { grid: ReturnType<typeof generateStage>['grid']; large?: boolean }) {
  return <div className={`mini-map ${large ? 'large' : ''}`} aria-label="Мини-карта стейджа">
    {grid.flatMap((row, y) => row.map((cell, x) => <i key={`${x}-${y}`} className={`mini-cell ${cell}`} />))}
  </div>;
}

function TrapIcon({ trap, className = '' }: { trap: TrapDef; className?: string }) {
  return <span className={`trap-icon element-${trap.element ?? 'physical'} ${className}`} aria-hidden="true"><i>{trap.icon}</i></span>;
}

function ShapePreview({ offer }: { offer: TrapOffer }) {
  const maxX = Math.max(...offer.shape.map(p => p.x));
  const maxY = Math.max(...offer.shape.map(p => p.y));
  return <span className="shape-preview" style={{ '--shape-w': maxX + 1, '--shape-h': maxY + 1 } as React.CSSProperties}>
    {offer.shape.map((p, i) => <i key={i} style={{ left: p.x * 10, top: p.y * 10 }} />)}
  </span>;
}

function App() {
  const [screen, setScreen] = useState<'lobby' | 'game'>('lobby');
  const [seed, setSeed] = useState(() => Math.floor(100000 + Math.random() * 899999));
  const [deck, setDeck] = useState(DEFAULT_DECK);
  const [deckOpen, setDeckOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [enemyInfo, setEnemyInfo] = useState<EnemyKind | null>(null);
  const [runKey, setRunKey] = useState(0);
  const stage = useMemo(() => generateStage(seed), [seed]);
  const stageEnemies = useMemo(() => (Object.entries(wavePreview(10, stage.archetype)) as [EnemyKind, number][]).filter(([, count]) => count > 0).map(([kind]) => kind), [stage.archetype]);

  if (screen === 'game') return <GameScreen key={runKey} seed={seed} deck={deck} onReplay={() => setRunKey(k => k + 1)} onLobby={() => setScreen('lobby')} onNew={() => { setSeed(Math.floor(100000 + Math.random() * 899999)); setScreen('lobby'); }} />;

  const toggleDeck = (id: string) => setDeck(current => current.includes(id) ? (current.length > 1 ? current.filter(x => x !== id) : current) : current.length < 5 ? [...current, id] : current);
  return <main className="app-shell"><section className="mobile lobby">
    <img className="lobby-art" src="/assets/dungeon-lobby.png" alt="Подземелье хранителя" />
    <div className="lobby-vignette" />
    <header className="lobby-header"><span className="eyebrow">ЗАЩИТИ СВОЁ ПОДЗЕМЕЛЬЕ</span><h1>DUNGEON <b>HEART</b></h1></header>

    <article className="stage-card stone-card">
      <div className="stage-card-head"><span>СТЕЙДЖ · {seed}</span><button className="info-btn" onClick={() => setInfoOpen(true)} aria-label="Информация о стейдже">i</button></div>
      <h2>{stage.name}</h2><p>{stage.tagline}</p>
      <div className="stage-card-body">
        <MiniMap grid={stage.grid} />
        <div className="stage-intel"><span className="archetype"><i />{stage.archetype}</span><small>ВТОРЖЕНИЕ</small><div className="enemy-strip">
          {stageEnemies.map(kind => <button key={kind} onClick={() => setEnemyInfo(kind)} aria-label={ENEMIES[kind].name}><b>{ENEMY_HINTS[kind].mark}</b><span>{ENEMIES[kind].name}</span></button>)}
        </div></div>
      </div>
    </article>

    <div className="lobby-actions">
      <button className="secondary-btn" onClick={() => setDeckOpen(true)}><span>Сменить колоду</span><b>{deck.length}/5</b></button>
      <button className="primary-btn" onClick={() => setScreen('game')}><span>В бой</span><i>›</i></button>
      <button className="text-btn" onClick={() => setSeed(Math.floor(100000 + Math.random() * 899999))}>Сгенерировать новый стейдж</button>
    </div>

    {deckOpen && <div className="modal-backdrop"><div className="modal stone-card deck-modal">
      <button className="modal-close" onClick={() => setDeckOpen(false)}>×</button><span className="eyebrow">АРСЕНАЛ ХРАНИТЕЛЯ</span><h2>Выбери 5 ловушек</h2>
      <div className="deck-grid">{Object.values(TRAPS).map(trap => <button key={trap.id} className={`deck-item ${deck.includes(trap.id) ? 'active' : ''}`} onClick={() => toggleDeck(trap.id)}>
        <TrapIcon trap={trap} /><span>{trap.name}</span><small>{trap.placement === 'floor' ? 'НА ПОЛ' : 'В СТЕНУ'} · {trap.short}</small>
      </button>)}</div>
      <button className="primary-btn compact" disabled={deck.length !== 5} onClick={() => setDeckOpen(false)}>Готово · {deck.length}/5</button>
    </div></div>}

    {infoOpen && <div className="modal-backdrop"><div className="modal stone-card info-modal">
      <button className="modal-close" onClick={() => setInfoOpen(false)}>×</button><span className="eyebrow">РАЗВЕДКА</span><h2>{stage.name}</h2>
      <div className="stage-info-map"><MiniMap grid={stage.grid} large /><div><p>{stage.tagline}</p><div className="intel-row"><b>Архетип</b><span>{stage.archetype}</span></div><div className="intel-row"><b>Входы</b><span>{stage.entrances.length}</span></div><div className="intel-row"><b>Сердце</b><span>Нижняя треть</span></div></div></div>
      <div className="enemy-info-list">{stageEnemies.map(kind => <button key={kind} onClick={() => setEnemyInfo(kind)}><b>{ENEMY_HINTS[kind].mark}</b><span>{ENEMIES[kind].name}</span></button>)}</div>
      <button className="primary-btn compact" onClick={() => setInfoOpen(false)}>Понятно</button>
    </div></div>}

    {enemyInfo && <div className="modal-backdrop enemy-hint-backdrop" onClick={() => setEnemyInfo(null)}><div className="enemy-hint stone-card" onClick={e => e.stopPropagation()}>
      <button className="modal-close" onClick={() => setEnemyInfo(null)}>×</button><b className="enemy-mark">{ENEMY_HINTS[enemyInfo].mark}</b><h2>{ENEMIES[enemyInfo].name}</h2><p>{ENEMY_HINTS[enemyInfo].danger}</p><strong>Рекомендуется</strong><span>{ENEMY_HINTS[enemyInfo].counter}</span>
    </div></div>}
  </section></main>;
}

function GameScreen({ seed, deck, onReplay, onLobby, onNew }: { seed: number; deck: string[]; onReplay: () => void; onLobby: () => void; onNew: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [showStats, setShowStats] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    let cancelled = false, current: GameEngine | null = null;
    void import('./game/GameEngine').then(({ GameEngine }) => {
      if (cancelled || !host.current) return;
      current = new GameEngine(seed, deck, setSnapshot); engineRef.current = current; void current.mount(host.current);
    });
    return () => { cancelled = true; if (engineRef.current === current) engineRef.current = null; current?.destroy(); };
  }, [seed, deck]);

  const engine = engineRef.current;
  const selectedTrap = engine && snapshot.selectedTrap && snapshot.selectedTrap !== 'heart' ? engine.traps.find(t => t.id === snapshot.selectedTrap) : null;
  const selectedDef = selectedTrap ? TRAPS[selectedTrap.trapId] : null;
  const upgradePrice = selectedTrap ? trapUpgradePrice(selectedTrap.pricePaid, selectedTrap.level) : 0;
  const heartUpgrade = 22 + snapshot.heartLevel * 7;
  const prepLocked = snapshot.moveMode || !!snapshot.terrainMode;

  return <main className="app-shell"><section className={`mobile game-screen phase-${snapshot.phase} ${snapshot.moveMode ? 'is-moving' : ''}`}>
    <div ref={host} className="pixi-host" />
    <header className="battle-hud">
      <div className="wave-pill"><small>ВОЛНА</small><b>{snapshot.wave}<i>/10</i></b></div>
      <div className="heart-hud"><button className="heart-icon" onClick={() => engineRef.current?.selectHeart()} aria-label="Dungeon Heart">♥</button><div><div className="hp-label"><b>DUNGEON HEART</b><span>LVL {snapshot.heartLevel}</span></div><div className="hp-track"><i style={{ width: `${snapshot.hp / snapshot.maxHp * 100}%` }} /></div><small>{snapshot.hp} / {snapshot.maxHp}</small></div></div>
      <div className="coin-pill"><span>◆</span><b>{snapshot.coins}</b></div>
    </header>

    {snapshot.phase === 'prep' && <>
      <div className="terrain-tools">
        <button className={snapshot.terrainMode === 'dig' ? 'active' : ''} disabled={snapshot.moveMode} onClick={() => engineRef.current?.setTerrainMode('dig')}><b>⛏</b><span>Копать</span></button>
        <button className={snapshot.terrainMode === 'build' ? 'active' : ''} disabled={snapshot.moveMode} onClick={() => engineRef.current?.setTerrainMode('build')}><b>▦</b><span>Стена</span></button>
      </div>
      {!snapshot.moveMode && <div className={`shop-panel ${snapshot.terrainMode ? 'mode-active' : ''}`}>
        <div className="wave-intel"><div><small>СЛЕДУЮЩАЯ ВОЛНА</small><b>{snapshot.activeEntrances} {snapshot.activeEntrances === 1 ? 'вход' : 'входа'}</b></div><div className="threat-icons">{(Object.entries(snapshot.preview) as [EnemyKind, number][]).filter(([, count]) => count > 0).map(([kind, count]) => <span key={kind} title={ENEMIES[kind].name}><b>{ENEMY_HINTS[kind].mark}</b><i>×{count}</i></span>)}</div></div>
        <div className="shop-head"><span>ЛОВУШКИ</span><button disabled={!!snapshot.terrainMode} onClick={() => engineRef.current?.reroll()}>Обновить <b>◆{engine?.rerollCost ?? 3}</b></button></div>
        <div className="offer-row">{[0, 1, 2].map(index => { const offer = snapshot.offers[index]; if (!offer) return <div key={index} className="offer-card empty">Куплено</div>; const trap = TRAPS[offer.trapId]; return <div key={offer.id} data-testid={`offer-${index}`} className={`offer-card placement-${trap.placement} element-${trap.element ?? 'physical'} ${snapshot.selectedOffer === offer.id ? 'dragging' : ''} ${snapshot.coins < offer.price ? 'disabled' : ''}`}>
          <button className={`freeze ${offer.frozen ? 'active' : ''}`} onPointerDown={e => e.stopPropagation()} onClick={() => engineRef.current?.toggleFreeze(offer.id)} aria-label="Заморозить предложение">❄</button>
          <button className="offer-main" disabled={!!snapshot.terrainMode} onPointerDown={e => { e.preventDefault(); engineRef.current?.beginOfferDrag(offer.id, e.clientX, e.clientY); }}>
            <TrapIcon trap={trap} /><b>{trap.name}</b><ShapePreview offer={offer} /><small className="placement-label">{trap.placement === 'floor' ? '▤ НА ПОЛ' : '▥ В СТЕНУ'} · {offer.shape.length} КЛ.</small><strong>◆ {offer.price}</strong>
          </button>
        </div>})}</div>
        <button className="launch-btn" disabled={prepLocked} onClick={() => engineRef.current?.startWave()}><span>Запустить волну {snapshot.wave}</span><i>›</i></button>
      </div>}
    </>}

    <div className={`status-toast ${snapshot.phase}`}>{snapshot.message}</div>

    {snapshot.phase === 'combat' && <div className="combat-controls"><button onClick={() => engineRef.current?.togglePause()}>Ⅱ</button><button onClick={() => engineRef.current?.toggleSpeed()}>×{snapshot.speed}</button><div><b>{snapshot.enemyCount}</b><small>В ПОДЗЕМЕЛЬЕ</small></div></div>}

    {snapshot.phase === 'prep' && snapshot.moveMode && <div className="move-toolbar"><div><b>Перемещение</b><span>Тащи любую ловушку. Все изменения бесплатны.</span></div><button className="move-cancel" onClick={() => engineRef.current?.cancelMove()}>Отмена</button><button className="move-confirm" disabled={!!snapshot.movingTrap} onClick={() => engineRef.current?.finishMoveMode()}>✓</button></div>}

    {snapshot.phase === 'prep' && snapshot.selectedTrap && !snapshot.moveMode && <div className="context-panel">
      {snapshot.selectedTrap === 'heart' ? <><b>DUNGEON HEART · LVL {snapshot.heartLevel}</b><div><button onClick={() => engineRef.current?.upgradeHeart()} disabled={snapshot.heartLevel >= 10}>▲ Улучшить <i>◆{heartUpgrade}</i></button><button onClick={() => engineRef.current?.repairHeart()} disabled={snapshot.hp >= snapshot.maxHp}>♥ Ремонт <i>◆{engine?.repairCost ?? 8}</i></button></div></> : selectedTrap && selectedDef ? <><b>{selectedDef.name} · LVL {selectedTrap.level}</b><div className="trap-actions"><button onClick={() => engineRef.current?.startMoveSelected()}>✥ Переместить</button><button onClick={() => engineRef.current?.upgradeSelected()} disabled={selectedTrap.level >= 3}>▲ {selectedTrap.level >= 3 ? 'MAX' : <><span>+50%</span> <i>◆{upgradePrice}</i></>}</button><button className="sell" onClick={() => engineRef.current?.sellSelected()}>Продать <i>+◆{Math.floor(selectedTrap.pricePaid / 2)}</i></button></div></> : null}
    </div>}

    {snapshot.phase === 'perk' && <div className="modal-backdrop"><div className="modal perk-modal stone-card"><span className="eyebrow">НОВЫЙ УРОВЕНЬ ПОДЗЕМЕЛЬЯ</span><h2>Выбери улучшение</h2><div className="perk-grid">{snapshot.perkChoices.map(perk => <button key={perk.id} onClick={() => engineRef.current?.choosePerk(perk.id)} style={{ '--perk': perk.color } as React.CSSProperties}><i>◆</i><small>{perk.branch}</small><b>{perk.name}</b><span>{perk.text}</span></button>)}</div></div></div>}

    {snapshot.phase === 'result' && <div className="modal-backdrop result-backdrop"><div className="result-modal stone-card"><div className="result-seal">{snapshot.stars > 0 ? '♛' : '☠'}</div><span className="eyebrow">СТЕЙДЖ ЗАВЕРШЁН</span><h2>{snapshot.stars > 0 ? 'ПОДЗЕМЕЛЬЕ ВЫСТОЯЛО' : 'СЕРДЦЕ РАЗРУШЕНО'}</h2><div className="stars">{[1, 2, 3].map(s => <i key={s} className={snapshot.stars >= s ? 'lit' : ''}>★</i>)}</div><div className="result-summary"><span><small>ВОЛНА</small><b>{snapshot.stats.wavesCleared}/10</b></span><span><small>HP</small><b>{snapshot.hp}/{snapshot.maxHp}</b></span><span><small>УБИТО</small><b>{snapshot.stats.killed}</b></span></div>
      <button className="stats-toggle" onClick={() => setShowStats(x => !x)}>Подробная статистика</button>{showStats && <div className="stats-grid">
        <span>Убийства пропастью <b>{snapshot.stats.pitKills}</b></span><span>Прорвались к базе <b>{snapshot.stats.leaked}</b></span><span>Пропущенный урон <b>{snapshot.stats.damageTaken}</b></span><span>Урон Dungeon Heart <b>{Math.round(snapshot.stats.heartDamage)}</b></span><span>Макс. уровень Heart <b>{snapshot.stats.maxHeartLevel}</b></span><span>Стены / раскопки <b>{snapshot.stats.builtWalls} / {snapshot.stats.digs}</b></span>
        {Object.entries(snapshot.stats.trapLevels).map(([id, level]) => <span key={`trap-${id}`}>{TRAPS[id]?.name ?? id} · LVL {level}<b>{Math.round(snapshot.stats.trapDamage[id] ?? 0)} dmg</b></span>)}
        {Object.entries(snapshot.stats.reactionCount).map(([name, count]) => <span key={`reaction-${name}`}>{name} ×{count}<b>{Math.round(snapshot.stats.reactionDamage[name] ?? 0)} dmg</b></span>)}
      </div>}
      <div className="result-actions"><button className="primary-btn compact" onClick={onReplay}>Повторить</button><button className="secondary-btn" onClick={onLobby}>В лобби</button><button className="text-btn" onClick={onNew}>Новый стейдж</button></div>
    </div></div>}
  </section></main>;
}

export default App;
