'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'

type Weapon = 'unarmed' | 'bat' | 'blade'
type Player = {
  id: string
  name: string
  color: string
  lives: number
  progress: number
  status: 'RUNNING' | 'FINISHED' | 'OUT'
  weapon: Weapon
  x: number
  y: number
  vx: number
  vy: number
  hidden: boolean
  attack: number
  rank?: number | null
  isHost?: boolean
}

type Hazard = {
  id: string
  x: number
  type: 'cactus' | 'rock' | 'bush' | 'bird' | 'wolf' | 'box'
  lane: number
  hit?: boolean
}

type Pickup = {
  id: string
  x: number
  weapon: Exclude<Weapon, 'unarmed'>
  picked?: boolean
}

type LocalGame = {
  running: boolean
  x: number
  vx: number
  y: number
  vy: number
  hidden: boolean
  hideMeter: number
  hideCooldown: number
  weapon: Weapon
  attack: number
  attackHit: boolean
  invincible: number
  flash: number
  lives: number
  hazards: Hazard[]
  pickups: Pickup[]
  finishers: string[]
  message: string
}

const COLORS = ['#ffd600', '#ff3b30', '#00c853', '#007aff', '#ff9500', '#af52de', '#5856d6', '#ff2d55']

function createPRNG(seed: number) {
  let s = (seed % 2147483647) || 12345
  if (s <= 0) s += 2147483646
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

function generateTrack(seed: number): { hazards: Hazard[]; pickups: Pickup[] } {
  const rand = createPRNG(seed)
  const hazards: Hazard[] = []
  const pickups: Pickup[] = []
  const types: Hazard['type'][] = ['cactus', 'rock', 'bush', 'bird', 'wolf', 'box']

  let currentX = 650
  let hId = 0
  while (currentX < 8100) {
    currentX += 280 + Math.floor(rand() * 420)
    if (currentX >= 8100) break
    const type = types[Math.floor(rand() * types.length)]
    const lane = rand() > 0.72 ? 1 : 0
    hazards.push({ id: `h_${hId++}`, x: currentX, type, lane, hit: false })
  }

  let pX = 900
  let pId = 0
  while (pX < 7800) {
    pX += 750 + Math.floor(rand() * 650)
    if (pX >= 8000) break
    const weapon: 'bat' | 'blade' = rand() > 0.5 ? 'bat' : 'blade'
    pickups.push({ id: `p_${pId++}`, x: pX, weapon, picked: false })
  }

  return { hazards, pickups }
}

function initialGame(): LocalGame {
  return {
    running: false,
    x: 0,
    vx: 0,
    y: 0,
    vy: 0,
    hidden: false,
    hideMeter: 100,
    hideCooldown: 0,
    weapon: 'unarmed',
    attack: 0,
    attackHit: false,
    invincible: 0,
    flash: 0,
    lives: 5,
    hazards: [],
    pickups: [],
    finishers: [],
    message: 'Waiting at the starting line',
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef(0)
  const lastRef = useRef(0)
  const socketRef = useRef<Socket | null>(null)
  const gameRef = useRef<LocalGame>(initialGame())
  const lastEmitRef = useRef(0)

  const [connected, setConnected] = useState(false)
  const [inRoom, setInRoom] = useState(false)
  const [roomCode, setRoomCode] = useState('PX7K2')
  const [playerName, setPlayerName] = useState('')
  const [myId, setMyId] = useState('')
  const [phase, setPhase] = useState<'entry' | 'lobby' | 'race' | 'results'>('entry')
  const [players, setPlayers] = useState<Player[]>([])
  const [showRules, setShowRules] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isJoining, setIsJoining] = useState(false)
  const [, redraw] = useState(0)

  const update = useCallback(() => redraw(n => n + 1), [])

  // Socket Connection Lifecycle
  useEffect(() => {
    const socket = io({
      transports: ['websocket', 'polling'],
      autoConnect: true,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      setErrorMessage(null)
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    // Room update: server authoritative player list
    socket.on('room-update', (data: { roomId: string; status: 'lobby' | 'in-progress' | 'results'; players: Player[]; finishers?: string[] }) => {
      setPlayers(data.players || [])
      if (data.status === 'lobby') {
        setPhase(current => (current === 'entry' ? 'entry' : 'lobby'))
      }
    })

    // Joined room confirmation
    socket.on('joined-room', (res: { success: boolean; player: Player; room: { id: string; status: 'lobby' | 'in-progress' | 'results'; players: Player[] } }) => {
      setIsJoining(false)
      if (res && res.success && res.player && res.room) {
        setMyId(res.player.id)
        setPlayers(res.room.players || [res.player])
        setInRoom(true)
        setPhase('lobby')
        setErrorMessage(null)
        gameRef.current = initialGame()
      }
    })

    // Player left
    socket.on('player-left', (data: { playerId: string }) => {
      setPlayers(prev => prev.filter(p => p.id !== data.playerId))
    })

    // Player joined
    socket.on('player-joined', (data: { player: Player }) => {
      setPlayers(prev => {
        if (prev.some(p => p.id === data.player.id)) return prev
        return [...prev, data.player]
      })
    })

    // Race started
    socket.on('race-started', (data: { seed: number; players: Player[] }) => {
      const track = generateTrack(data.seed)
      gameRef.current = {
        ...initialGame(),
        running: true,
        hazards: track.hazards,
        pickups: track.pickups,
        message: 'GO! Sprint to the signal flare!',
      }
      setPlayers(data.players || [])
      setPhase('race')
      setErrorMessage(null)
    })

    // Remote player moved
    socket.on('player-moved', (data: Partial<Player> & { playerId: string }) => {
      setPlayers(prev =>
        prev.map(p => {
          if (p.id === data.playerId) {
            return {
              ...p,
              x: data.x ?? p.x,
              y: data.y ?? p.y,
              vx: data.vx ?? p.vx,
              vy: data.vy ?? p.vy,
              hidden: data.hidden ?? p.hidden,
              weapon: (data.weapon as Weapon) ?? p.weapon,
              attack: data.attack ?? p.attack,
              lives: data.lives ?? p.lives,
              status: data.status ?? p.status,
              progress: data.progress ?? p.progress,
            }
          }
          return p
        })
      )
    })

    // Remote player attacked
    socket.on('player-attacked', (data: { attackerId: string; weapon: Weapon; x: number; y: number; hidden: boolean }) => {
      const g = gameRef.current
      if (g.running && g.invincible <= 0 && !g.hidden) {
        const dx = Math.abs(g.x - data.x)
        const dy = Math.abs(g.y - data.y)
        if (dx < 75 && dy < 50) {
          g.lives = Math.max(0, g.lives - 1)
          g.x = Math.max(0, g.x - 40)
          g.invincible = 1.2
          g.flash = 0.3
          g.message = `Ambushed! Lost 1 life (-40m)`
          socket.emit('player-update', {
            x: g.x,
            y: g.y,
            lives: g.lives,
            progress: Math.min(100, Math.round(g.x / 82)),
          })
        }
      }
    })

    // Remote pickup collected
    socket.on('pickup-collected', (data: { playerId: string; pickupId: string; weapon: Weapon }) => {
      const g = gameRef.current
      const target = g.pickups.find(p => p.id === data.pickupId || `${p.x}_${p.weapon}` === data.pickupId)
      if (target) target.picked = true
    })

    // Player finished
    socket.on('player-finished', (data: { playerId: string; rank: number; finishers: string[] }) => {
      setPlayers(prev =>
        prev.map(p => (p.id === data.playerId ? { ...p, status: 'FINISHED', rank: data.rank } : p))
      )
    })

    // Race ended
    socket.on('race-ended', (data: { finishers: string[]; players: Player[] }) => {
      gameRef.current.running = false
      setPlayers(data.players || [])
      setPhase('results')
    })

    // Reset back to lobby
    socket.on('room-reset', (data: { status: 'lobby'; players: Player[] }) => {
      gameRef.current = initialGame()
      setPlayers(data.players || [])
      setPhase('lobby')
    })

    // Join error
    socket.on('join-error', (err: { code: string; message: string }) => {
      setIsJoining(false)
      setErrorMessage(err.message || 'Failed to join room.')
    })

    const handleBeforeUnload = () => {
      socket.emit('leave-room')
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('pagehide', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('pagehide', handleBeforeUnload)
      socket.emit('leave-room')
      socket.disconnect()
    }
  }, [])

  // Join Room
  const joinRoom = useCallback(() => {
    const socket = socketRef.current
    if (!socket || !connected) {
      setErrorMessage('Connecting to server... please wait a moment.')
      return
    }

    const cleanRoom = roomCode.trim().toUpperCase().slice(0, 8) || 'PX7K2'
    setRoomCode(cleanRoom)
    setIsJoining(true)
    setErrorMessage(null)

    socket.emit(
      'join-room',
      { roomId: cleanRoom, name: playerName.trim() || undefined },
      (res: { success: boolean; code?: string; message?: string; player?: Player; room?: { id: string; status: 'lobby' | 'in-progress' | 'results'; players: Player[] } }) => {
        setIsJoining(false)
        if (res && res.success && res.player && res.room) {
          setMyId(res.player.id)
          setPlayers(res.room.players || [res.player])
          setInRoom(true)
          setPhase('lobby')
          setErrorMessage(null)
          gameRef.current = initialGame()
        } else {
          setErrorMessage(res?.message || 'Could not join room.')
        }
      }
    )
  }, [connected, roomCode, playerName])

  // Leave Room Action
  const leaveRoom = useCallback(() => {
    const socket = socketRef.current
    if (socket) {
      socket.emit('leave-room')
    }
    setInRoom(false)
    setPhase('entry')
    setPlayers([])
    setMyId('')
    setErrorMessage(null)
    gameRef.current = initialGame()
  }, [])

  // Start Race (Host only)
  const startRace = useCallback(() => {
    const socket = socketRef.current
    if (socket) {
      socket.emit('start-race')
    }
  }, [])

  // Reset Race Action
  const resetRace = useCallback(() => {
    const socket = socketRef.current
    if (socket) {
      socket.emit('reset-race')
    }
  }, [])

  // Player Controls
  const jump = useCallback(() => {
    const g = gameRef.current
    if (g.running && g.y === 0) g.vy = 650
  }, [])

  const move = useCallback((direction: number, sprint = false) => {
    const g = gameRef.current
    if (g.running) g.vx = direction * (sprint ? 380 : 250)
  }, [])

  const stopMove = useCallback(() => {
    const g = gameRef.current
    if (g.running) g.vx = 0
  }, [])

  const hide = useCallback(() => {
    const g = gameRef.current
    if (g.running && g.hideCooldown <= 0 && g.hideMeter > 15) {
      g.hidden = !g.hidden
      g.hideCooldown = g.hidden ? 2.2 : 0.4
      g.message = g.hidden ? 'Hidden in cover — ambush ready!' : 'Stepped out of cover'
    }
  }, [])

  const attack = useCallback(() => {
    const g = gameRef.current
    if (g.running && g.weapon !== 'unarmed' && g.attack <= 0) {
      g.attack = 0.38
      g.attackHit = false
      g.message = g.hidden ? 'Ambush strike!' : 'Weapon swing!'
      const socket = socketRef.current
      if (socket) {
        socket.emit('player-attacked', {
          weapon: g.weapon,
          x: g.x,
          y: g.y,
          hidden: g.hidden,
        })
      }
      g.hidden = false
    }
  }, [])

  // Keyboard Event Handlers
  useEffect(() => {
    const pressedKeys = new Set<string>()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (phase !== 'race') return
      if (
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'ShiftLeft', 'ShiftRight', 'KeyF', 'KeyE'].includes(
          e.code
        )
      ) {
        e.preventDefault()
      }

      pressedKeys.add(e.code)

      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') jump()
      if (e.code === 'ArrowDown' || e.code === 'KeyS') hide()
      if (e.code === 'KeyF' || e.code === 'KeyE') attack()

      const isSprint = pressedKeys.has('ShiftLeft') || pressedKeys.has('ShiftRight')
      if (pressedKeys.has('ArrowRight') || pressedKeys.has('KeyD')) {
        move(1, isSprint)
      } else if (pressedKeys.has('ArrowLeft') || pressedKeys.has('KeyA')) {
        move(-1, isSprint)
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (phase !== 'race') return
      pressedKeys.delete(e.code)

      const isSprint = pressedKeys.has('ShiftLeft') || pressedKeys.has('ShiftRight')
      if (pressedKeys.has('ArrowRight') || pressedKeys.has('KeyD')) {
        move(1, isSprint)
      } else if (pressedKeys.has('ArrowLeft') || pressedKeys.has('KeyA')) {
        move(-1, isSprint)
      } else {
        stopMove()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [phase, attack, hide, jump, move, stopMove])

  // Canvas Drawing Routine
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      const g = gameRef.current
      ctx.clearRect(0, 0, w, h)

      // High-contrast clean background
      ctx.fillStyle = '#0f172a'
      ctx.fillRect(0, 0, w, h)

      // Track Terrain
      ctx.fillStyle = '#1e293b'
      ctx.fillRect(0, h * 0.54, w, h * 0.46)

      // Solid Ground Line
      ctx.fillStyle = '#ffd600'
      ctx.fillRect(0, h * 0.76, w, 4)

      // Track Grid Lines
      ctx.strokeStyle = '#334155'
      ctx.lineWidth = 2
      for (let x = -((g.x * 1.5) % 32); x < w; x += 32) {
        ctx.beginPath()
        ctx.moveTo(x, h * 0.81)
        ctx.lineTo(x + 13, h * 0.81)
        ctx.stroke()
      }

      const px = 160
      const base = h * 0.76 - g.y

      const pixel = (x: number, y: number, ww: number, hh: number, c: string) => {
        ctx.fillStyle = c
        ctx.fillRect(Math.round(x), Math.round(y), Math.round(ww), Math.round(hh))
      }

      const drawRunner = (x: number, y: number, c: string, name: string, weapon: Weapon, isHidden: boolean, isOut: boolean, isAttacking: boolean) => {
        ctx.save()
        if (isOut) {
          ctx.globalAlpha = 0.3
        }

        if (isHidden) {
          pixel(x - 5, y - 16, 46, 16, '#00c853')
          pixel(x + 2, y - 28, 32, 14, '#69f0ae')
        } else {
          // Character sprite with bold borders
          pixel(x + 9, y - 38, 18, 18, c)
          pixel(x + 5, y - 20, 27, 21, c)
          pixel(x + 10, y + 1, 7, 20, c)
          pixel(x + 24, y + 1, 7, 20, c)
          pixel(x + 5, y + 18, 14, 5, c)
          pixel(x + 24, y + 18, 14, 5, c)

          // Weapon
          if (weapon !== 'unarmed') {
            const weaponColor = weapon === 'blade' ? '#ffffff' : '#ffd600'
            if (isAttacking) {
              pixel(x + 36, y - 28, 28, 7, weaponColor)
            } else {
              pixel(x + 28, y - 18, 16, 5, weaponColor)
            }
          }
        }

        // Name tag in Neo-Brutalist badge
        ctx.font = 'bold 10px monospace'
        ctx.fillStyle = '#ffd600'
        ctx.textAlign = 'center'
        ctx.fillText(name.slice(0, 10), x + 18, y - 44)
        ctx.restore()
      }

      // Draw Remote Players
      players.forEach(p => {
        if (p.id === myId) return
        const screenX = px + (p.x - g.x)
        if (screenX < -100 || screenX > w + 100) return
        const screenY = h * 0.76 - (p.y || 0)
        drawRunner(
          screenX,
          screenY,
          p.color,
          p.name,
          p.weapon,
          p.hidden,
          p.lives <= 0 || p.status === 'OUT',
          p.attack > 0
        )
      })

      // Draw Local Player
      const localPlayer = players.find(p => p.id === myId)
      const myColor = localPlayer ? localPlayer.color : COLORS[0]
      const myName = localPlayer ? `${localPlayer.name} (YOU)` : 'YOU'
      if (g.flash > 0) {
        ctx.fillStyle = 'rgba(255, 59, 48, 0.4)'
        ctx.fillRect(0, 0, w, h)
      }
      drawRunner(
        px,
        base,
        myColor,
        myName,
        g.weapon,
        g.hidden,
        g.lives <= 0,
        g.attack > 0
      )

      // Draw Hazards
      g.hazards.forEach(o => {
        const x = px + o.x - g.x
        if (x < -80 || x > w + 80) return
        const y = h * 0.76 - (o.lane ? 66 : 0)

        if (o.type === 'cactus') {
          pixel(x + 10, y - 40, 13, 40, '#00c853')
          pixel(x, y - 25, 11, 9, '#00c853')
          pixel(x + 26, y - 30, 10, 9, '#00c853')
        } else if (o.type === 'rock') {
          pixel(x, y - 19, 36, 19, '#94a3b8')
        } else if (o.type === 'bush') {
          pixel(x, y - 21, 48, 21, '#00c853')
          pixel(x + 8, y - 31, 23, 12, '#69f0ae')
        } else if (o.type === 'box') {
          pixel(x, y - 30, 34, 30, '#b45309')
          pixel(x + 5, y - 25, 24, 4, '#ffd600')
        } else if (o.type === 'bird') {
          pixel(x, y - 14, 28, 8, '#ff3b30')
          pixel(x + 8, y - 23, 7, 9, '#ff3b30')
        } else if (o.type === 'wolf') {
          pixel(x, y - 22, 40, 17, '#a855f7')
          pixel(x + 28, y - 33, 15, 15, '#a855f7')
        }
      })

      // Draw Pickups
      g.pickups.forEach(p => {
        const x = px + p.x - g.x
        if (x > -60 && x < w + 60 && !p.picked) {
          pixel(x, h * 0.76 - 12, 30, 6, '#ffd600')
          pixel(x + 9, h * 0.76 - 26, 12, 15, p.weapon === 'blade' ? '#ffffff' : '#ffd600')
        }
      })

      // Finish Signal Flare (at 8200m)
      const finishX = px + 8200 - g.x
      if (finishX > -100 && finishX < w + 200) {
        ctx.fillStyle = '#ffd600'
        ctx.fillRect(finishX, h * 0.2, 6, h * 0.56)
        ctx.fillRect(finishX - 10, h * 0.2, 54, 26)
        ctx.fillStyle = '#000000'
        ctx.font = 'bold 11px monospace'
        ctx.fillText('FINISH', finishX + 17, h * 0.2 + 13)
      }

      // HUD Track Label
      ctx.fillStyle = '#ffd600'
      ctx.font = 'bold 11px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(`SECTOR 01 // ${players.length} LIVE RUNNERS`, 18, 26)
    },
    [players, myId]
  )

  // Simulation Loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = () => {
      const r = canvas.getBoundingClientRect()
      const d = window.devicePixelRatio || 1
      canvas.width = r.width * d
      canvas.height = r.height * d
      ctx.setTransform(d, 0, 0, d, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const loop = (now: number) => {
      const g = gameRef.current
      const dt = Math.min(0.04, (now - lastRef.current) / 1000 || 0)
      lastRef.current = now

      if (g.running) {
        g.x = Math.max(0, g.x + g.vx * dt)
        g.y += g.vy * dt
        g.vy -= 1600 * dt
        if (g.y <= 0) {
          g.y = 0
          g.vy = 0
        }

        g.hideCooldown -= dt
        g.hideMeter = clamp(g.hideMeter + (g.hidden ? -14 : 6) * dt, 0, 100)
        if (g.hideMeter <= 0) g.hidden = false
        g.invincible -= dt
        g.flash -= dt
        g.attack -= dt

        // Pickups
        g.pickups.forEach(p => {
          if (!p.picked && Math.abs(p.x - g.x) < 55) {
            p.picked = true
            g.weapon = p.weapon
            g.message = `${p.weapon.toUpperCase()} EQUIPPED`
            const socket = socketRef.current
            if (socket) {
              socket.emit('pickup-collected', {
                pickupId: p.id,
                x: p.x,
                weapon: p.weapon,
              })
            }
          }
        })

        // Hazards
        g.hazards.forEach(o => {
          const gap = o.x - g.x
          const dangerous = o.type !== 'bush' && o.type !== 'box' && gap > 0 && gap < 65 && Math.abs(g.y - (o.lane ? 66 : 0)) < 50
          if (dangerous && !o.hit && g.invincible <= 0 && !(g.hidden && o.type === 'wolf')) {
            o.hit = true
            g.lives = Math.max(0, g.lives - 1)
            g.x = Math.max(0, g.x - 50)
            g.invincible = 1.2
            g.flash = 0.25
            g.hidden = false
            g.attack = 0
            g.message = `Hit by ${o.type.toUpperCase()}! (-50m, ${g.lives} lives left)`
            if (g.lives === 0) g.message = 'Zero lives — keep racing to the finish!'
          }
        })

        // Finish line
        if (g.x >= 8200 && !g.finishers.includes(myId)) {
          g.finishers.push(myId)
          const socket = socketRef.current
          if (socket) {
            socket.emit('player-finished', { lives: g.lives })
          }
          g.message = 'Signal flare reached!'
        }

        // Broadcast local position
        if (now - lastEmitRef.current > 33) {
          lastEmitRef.current = now
          const socket = socketRef.current
          if (socket && connected) {
            const progress = Math.min(100, Math.round(g.x / 82))
            socket.emit('player-update', {
              x: g.x,
              y: g.y,
              vx: g.vx,
              vy: g.vy,
              hidden: g.hidden,
              weapon: g.weapon,
              attack: g.attack,
              lives: g.lives,
              status: g.lives <= 0 ? 'OUT' : g.x >= 8200 ? 'FINISHED' : 'RUNNING',
              progress,
            })
          }
        }

        update()
      }

      draw(ctx, canvas.clientWidth, canvas.clientHeight)
      frameRef.current = requestAnimationFrame(loop)
    }

    frameRef.current = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(frameRef.current)
      window.removeEventListener('resize', resize)
    }
  }, [draw, update, connected, myId])

  const g = gameRef.current
  const localPlayer = players.find(p => p.id === myId)
  const isHost = localPlayer ? !!localPlayer.isHost : false
  const touch = (fn: () => void) => (e: React.PointerEvent) => {
    e.preventDefault()
    fn()
  }

  return (
    <main className="arcade-shell">
      {/* Top Bar Header */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PX</span>
          <div>
            <strong>PIXEL PURSUIT</strong>
            <small>REAL-TIME SURVIVAL RUN</small>
          </div>
        </div>

        <div className="topbar-actions">
          <div className="network-badge">
            <span
              className="network-dot"
              style={{ backgroundColor: connected ? '#00c853' : '#ff3b30' }}
            />
            {connected ? 'LIVE SERVER' : 'CONNECTING...'}
          </div>

          {inRoom && (
            <button className="neo-button" onClick={leaveRoom} title="Leave room">
              ← LEAVE ROOM
            </button>
          )}

          <button className="neo-button neo-button-yellow" onClick={() => setShowRules(true)}>
            HOW TO PLAY ?
          </button>

          {inRoom && (
            <button className="neo-button" onClick={() => navigator.clipboard?.writeText(roomCode)}>
              ROOM: <strong>{roomCode}</strong> ⧉
            </button>
          )}
        </div>
      </header>

      {/* Global Error Banner */}
      {errorMessage && (
        <div
          style={{
            maxWidth: 1050,
            margin: '20px auto 0',
            padding: '14px 20px',
            background: '#fff0f0',
            border: '2.5px solid #000000',
            boxShadow: '4px 4px 0px #000000',
            fontWeight: '700',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '90%',
          }}
        >
          <span>
            <strong>NOTICE:</strong> {errorMessage}
          </span>
          <button
            onClick={() => setErrorMessage(null)}
            style={{ background: 'transparent', border: 'none', fontWeight: '900', fontSize: '16px' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ================= PHASE 1: Entry / Welcome (Matching Reference Image) ================= */}
      {phase === 'entry' && (
        <section className="hero-section">
          {/* Top pill badge */}
          <div className="badge-pill">ANONYMOUS & REAL-TIME MULTIPLAYER</div>

          {/* Main Giant Headline with Highlight Badge */}
          <h1 className="hero-title">
            RUN FAST. <span className="badge-highlight">SURVIVE.</span>
          </h1>

          {/* Subtitle description */}
          <p className="hero-subtitle">
            Real-time survival race with real runners, completely synchronized. No profiles, no bots, no pressure, just pure competition.
          </p>

          {/* Center Form Card */}
          <div className="entry-form-container">
            <div className="form-group">
              <label className="form-label" htmlFor="runnerName">
                CALL-SIGN (YOUR NAME)
              </label>
              <input
                id="runnerName"
                className="neo-input"
                placeholder="e.g. VIPER"
                maxLength={12}
                value={playerName}
                onChange={e => setPlayerName(e.target.value.toUpperCase())}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="room">
                ROOM CODE
              </label>
              <input
                id="room"
                className="neo-input"
                value={roomCode}
                maxLength={8}
                onChange={e => setRoomCode(e.target.value.toUpperCase())}
              />
            </div>

            <button className="hero-cta-button" onClick={joinRoom} disabled={isJoining}>
              {isJoining ? 'CONNECTING...' : 'START RUN'} <span>→</span>
            </button>
          </div>

          {/* Reference Bottom Badges Bar */}
          <div className="footer-bar" style={{ width: '100%', marginTop: 'auto' }}>
            <div className="footer-item">⚡ 100% REAL CONNECTED RUNNERS</div>
            <div className="footer-item">🎯 CLEAN START LINE REJOINS</div>
            <div className="footer-item">⚔️ LIVE AMBUSH COMBAT</div>
            <div className="footer-item">🛡️ ZERO BOTS OR GHOST PLAYERS</div>
          </div>
        </section>
      )}

      {/* ================= PHASE 2: Lobby Ready Room ================= */}
      {phase === 'lobby' && (
        <section className="lobby-layout">
          <div className="neo-card">
            <div className="badge-pill" style={{ marginBottom: 16 }}>
              ROOM CODE: {roomCode}
            </div>
            <h1 style={{ fontSize: 'clamp(36px, 5vw, 64px)', fontWeight: 900, margin: '0 0 16px', lineHeight: 1 }}>
              READY <span className="badge-highlight">ROOM.</span>
            </h1>
            <p style={{ color: 'var(--muted)', fontSize: '15px', lineHeight: 1.6, margin: '0 0 24px' }}>
              Share Room Code <strong>{roomCode}</strong> with friends. Active devices will appear in the runner roster below in real time.
            </p>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <button className="neo-button" onClick={leaveRoom}>
                ← BACK (LEAVE ROOM)
              </button>
              <button
                className="neo-button neo-button-yellow"
                onClick={() => navigator.clipboard?.writeText(roomCode)}
              >
                COPY ROOM CODE ⧉
              </button>
            </div>
          </div>

          <div className="neo-card">
            <div className="card-header-line">
              <span>ROOM: {roomCode}</span>
              <span className="badge-status">{isHost ? 'YOU ARE HOST' : 'WAITING FOR HOST'}</span>
            </div>

            <h2 style={{ fontSize: '18px', fontWeight: 900, margin: '0 0 14px', textTransform: 'uppercase' }}>
              RUNNER ROSTER ({players.length}/8)
            </h2>

            <div className="roster-list">
              {players.length === 0 ? (
                <div style={{ color: 'var(--muted)', padding: '16px 0', fontSize: '13px' }}>
                  Joining server room...
                </div>
              ) : (
                players.map(p => (
                  <div className="roster-card" key={p.id}>
                    <div className="runner-avatar-box" style={{ backgroundColor: p.color }}>
                      {p.name[0]}
                    </div>
                    <div className="runner-meta">
                      <strong>
                        {p.name} {p.id === myId && '(YOU)'}
                      </strong>
                      <small>{p.isHost ? 'HOST RUNNER' : 'CONNECTED RUNNER'}</small>
                    </div>
                    <span className="badge-status">READY</span>
                  </div>
                ))
              )}
            </div>

            {isHost ? (
              <button className="hero-cta-button" onClick={startRace}>
                START ROUND ({players.length} RUNNER{players.length > 1 ? 'S' : ''}) <span>→</span>
              </button>
            ) : (
              <div
                style={{
                  textAlign: 'center',
                  padding: 16,
                  background: '#fffae0',
                  border: '2px solid #000000',
                  boxShadow: '3px 3px 0px #000000',
                  fontWeight: '800',
                  fontSize: '13px',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              >
                WAITING FOR HOST TO START THE RUN...
              </div>
            )}
          </div>
        </section>
      )}

      {/* ================= PHASE 3: Live Race ================= */}
      {phase === 'race' && (
        <section className="game-layout">
          <div>
            <div className="race-header">
              <div>
                <span className="badge-pill" style={{ padding: '4px 10px', fontSize: '10px', marginBottom: 6 }}>
                  ROOM {roomCode} // LIVE MATCH
                </span>
                <h1>{g.message}</h1>
              </div>

              <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                <button className="neo-button" onClick={leaveRoom} style={{ padding: '8px 12px', fontSize: '10px' }}>
                  ← EXIT RUN
                </button>
                <div className="progress-badge">
                  <span>PROGRESS</span>
                  <strong>{Math.min(100, Math.round(g.x / 82))}%</strong>
                </div>
              </div>
            </div>

            <div className="canvas-frame">
              <canvas ref={canvasRef} aria-label="Pixel Pursuit race track" />
            </div>

            <div className="controls-row">
              <div className="key-pill">
                <kbd>A/D</kbd>
                <span>MOVE</span>
              </div>
              <div className="key-pill">
                <kbd>SHIFT</kbd>
                <span>SPRINT</span>
              </div>
              <div className="key-pill">
                <kbd>SPACE</kbd>
                <span>JUMP</span>
              </div>
              <div className="key-pill">
                <kbd>S</kbd>
                <span>HIDE</span>
              </div>
              <div className="key-pill">
                <kbd>F</kbd>
                <span>ATTACK</span>
              </div>

              <div className="hide-bar-container">
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', fontWeight: 800, fontFamily: 'JetBrains Mono' }}>
                  <span>HIDE METER</span>
                  <span>{Math.round(g.hideMeter)}%</span>
                </div>
                <div className="hide-bar-bg">
                  <div className="hide-bar-fill" style={{ width: `${g.hideMeter}%` }} />
                </div>
              </div>
            </div>

            <div className="mobile-actions">
              <button className="mobile-btn" onPointerDown={touch(() => move(-1))} onPointerUp={touch(stopMove)}>
                ← BACK
              </button>
              <button className="mobile-btn" onPointerDown={touch(() => move(1))} onPointerUp={touch(stopMove)}>
                FORWARD →
              </button>
              <button className="mobile-btn" onPointerDown={touch(() => move(1, true))} onPointerUp={touch(stopMove)}>
                SPRINT
              </button>
              <button className="mobile-btn mobile-btn-yellow" onPointerDown={touch(jump)}>
                JUMP
              </button>
              <button className="mobile-btn" onPointerDown={touch(hide)}>
                HIDE
              </button>
              <button className="mobile-btn mobile-btn-yellow" onPointerDown={touch(attack)}>
                ATTACK
              </button>
            </div>
          </div>

          <aside className="neo-card" style={{ height: 'fit-content' }}>
            <div className="card-header-line">
              <span>LIVE STANDINGS</span>
              <span>TOP 3 PODIUM</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {players.map((p, i) => (
                <div className={`live-row-box ${p.id === myId ? 'current-player' : ''}`} key={p.id}>
                  <strong style={{ fontFamily: 'JetBrains Mono', fontSize: '12px', width: '24px' }}>
                    {p.rank ? `#${p.rank}` : `0${i + 1}`}
                  </strong>
                  <div className="runner-avatar-box" style={{ backgroundColor: p.color, width: 28, height: 28, fontSize: 12 }}>
                    {p.name[0]}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: '12px' }}>
                      {p.name} {p.id === myId && '(YOU)'}
                    </div>
                    <div style={{ fontFamily: 'JetBrains Mono', fontSize: '9px', color: 'var(--muted)' }}>
                      {p.status} · {p.weapon ? p.weapon.toUpperCase() : 'UNARMED'}
                    </div>
                  </div>
                  <div style={{ color: 'var(--red)', fontSize: '12px', letterSpacing: '1px' }}>
                    {'♥'.repeat(clamp(p.lives ?? 5, 0, 5))}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 24, paddingTop: 16, borderTop: '2px solid #000' }}>
              <div style={{ fontFamily: 'JetBrains Mono', fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', marginBottom: 8 }}>
                TACTICAL INTEL
              </div>
              <p style={{ color: 'var(--muted)', fontSize: '11px', lineHeight: 1.6, margin: 0 }}>
                • Cover in bushes hides you from rival sight & ambush hits.
                <br />
                • Bats & Blades deal melee pushback.
                <br />
                • First 3 to 8200m win the podium!
              </p>
            </div>
          </aside>
        </section>
      )}

      {/* ================= PHASE 4: Results Screen ================= */}
      {phase === 'results' && (
        <div className="neo-modal-overlay">
          <div className="neo-modal-card" style={{ maxWidth: 520 }}>
            <div className="badge-pill">SIGNAL FLARE REACHED</div>
            <h1 style={{ fontSize: '38px', fontWeight: 900, margin: '0 0 12px' }}>
              PODIUM <span className="badge-highlight">COMPLETE.</span>
            </h1>
            <p style={{ color: 'var(--muted)', fontSize: '14px', margin: '0 0 24px' }}>
              The round concluded as runners crossed the final sector flare.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 28 }}>
              {players
                .filter(p => p.rank)
                .sort((a, b) => (a.rank || 9) - (b.rank || 9))
                .map(p => (
                  <div className="roster-card" key={p.id}>
                    <div className="badge-status" style={{ fontSize: '14px', fontWeight: 900 }}>
                      #{p.rank}
                    </div>
                    <div className="runner-avatar-box" style={{ backgroundColor: p.color }}>
                      {p.name[0]}
                    </div>
                    <div className="runner-meta">
                      <strong>
                        {p.name} {p.id === myId && '(YOU)'}
                      </strong>
                      <small>{p.lives} lives remaining</small>
                    </div>
                  </div>
                ))}
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              {isHost && (
                <button className="hero-cta-button" onClick={resetRace} style={{ flex: 1 }}>
                  PLAY AGAIN <span>→</span>
                </button>
              )}
              <button className="neo-button" onClick={leaveRoom} style={{ flex: 1, padding: '16px', justifyContent: 'center' }}>
                ← BACK TO ROOMS
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= HOW TO PLAY MODAL ================= */}
      {showRules && (
        <div className="neo-modal-overlay" onClick={() => setShowRules(false)}>
          <div className="neo-modal-card" onClick={e => e.stopPropagation()}>
            <div className="card-header-line">
              <span>FIELD MANUAL // COMBAT SURVIVAL</span>
              <button
                onClick={() => setShowRules(false)}
                style={{ background: 'none', border: 'none', fontWeight: 900, fontSize: 18 }}
              >
                ✕
              </button>
            </div>

            <h2 style={{ fontSize: '32px', fontWeight: 900, margin: '0 0 10px' }}>
              RUN. FIGHT. <span className="badge-highlight">SURVIVE.</span>
            </h2>
            <p style={{ color: 'var(--muted)', fontSize: '14px', margin: '0 0 24px' }}>
              Sprint 8200m across hostile terrain with other live runners. First 3 across the signal flare claim the podium.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 18, marginBottom: 28 }}>
              <div className="neo-card" style={{ padding: 18 }}>
                <strong style={{ fontSize: 13, textTransform: 'uppercase' }}>1. MOVEMENT</strong>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6, marginTop: 8 }}>
                  <kbd>A/D</kbd> or Arrows move. Hold <kbd>SHIFT</kbd> to sprint. <kbd>SPACE</kbd>/<kbd>W</kbd> jumps.
                </p>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6 }}>
                  <kbd>S</kbd>/<kbd>DOWN</kbd> hides in bushes and protects from ambushes.
                </p>
              </div>

              <div className="neo-card" style={{ padding: 18 }}>
                <strong style={{ fontSize: 13, textTransform: 'uppercase' }}>2. COMBAT</strong>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6, marginTop: 8 }}>
                  Walk over a bat or blade to equip it. Press <kbd>F</kbd> or <kbd>E</kbd> to swing.
                </p>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6 }}>
                  Ambush strikes from bushes deal direct damage and push competitors back 40m.
                </p>
              </div>

              <div className="neo-card" style={{ padding: 18 }}>
                <strong style={{ fontSize: 13, textTransform: 'uppercase' }}>3. SURVIVE</strong>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6, marginTop: 8 }}>
                  Cacti, rocks, birds, and wolves cost 1 life and push you back 50m.
                </p>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6 }}>
                  Zero lives lets you keep running as a ghost to reach the finish.
                </p>
              </div>
            </div>

            <button className="hero-cta-button" onClick={() => setShowRules(false)}>
              CLOSE MANUAL <span>→</span>
            </button>
          </div>
        </div>
      )}
    </main>
  )
}
