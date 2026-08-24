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

const COLORS = ['#f9c74f', '#f94144', '#43aa8b', '#577590', '#f9844a', '#9b5de5', '#00bbf9', '#f15bb5']

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
    message: 'Waiting at starting line',
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
      if (data.status === 'lobby' && phase !== 'entry') {
        setPhase('lobby')
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
          // Local player is hit by attacker!
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

    // Join error (mid-race block, room full, etc.)
    socket.on('join-error', (err: { code: string; message: string }) => {
      setIsJoining(false)
      setErrorMessage(err.message || 'Failed to join room.')
    })

    // Cleanup on tab close / unmount
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
  }, [phase])

  // Join Room Action
  const joinRoom = useCallback(() => {
    const socket = socketRef.current
    if (!socket || !connected) {
      setErrorMessage('Connecting to game server... please try again.')
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
          // Clean fresh local state
          gameRef.current = initialGame()
        } else {
          setErrorMessage(res?.message || 'Could not join room.')
        }
      }
    )
  }, [connected, roomCode, playerName])

  // Leave Room / Back Button Action
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

  // Start Race Action (Host only)
  const startRace = useCallback(() => {
    const socket = socketRef.current
    if (socket) {
      socket.emit('start-race')
    }
  }, [])

  // Reset Race Action (Host / Player in results screen)
  const resetRace = useCallback(() => {
    const socket = socketRef.current
    if (socket) {
      socket.emit('reset-race')
    }
  }, [])

  // Controls
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

      // Background Sky
      ctx.fillStyle = '#0d1b2a'
      ctx.fillRect(0, 0, w, h)

      // Background Terrain
      ctx.fillStyle = '#12263a'
      ctx.fillRect(0, h * 0.54, w, h * 0.46)

      // Track Ground Line
      ctx.fillStyle = '#18374a'
      ctx.fillRect(0, h * 0.76, w, 4)

      // Scrolling Track Grid Lines
      ctx.strokeStyle = '#1e3b50'
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
          // Bush cover sprite
          pixel(x - 5, y - 16, 46, 16, '#2a9d5b')
          pixel(x + 2, y - 28, 32, 14, '#3bab64')
        } else {
          // Character sprite
          pixel(x + 9, y - 38, 18, 18, c) // Head
          pixel(x + 5, y - 20, 27, 21, c) // Body
          pixel(x + 10, y + 1, 7, 20, c) // Left leg
          pixel(x + 24, y + 1, 7, 20, c) // Right leg
          pixel(x + 5, y + 18, 14, 5, c) // Left foot
          pixel(x + 24, y + 18, 14, 5, c) // Right foot

          // Weapon Sprite
          if (weapon !== 'unarmed') {
            const weaponColor = weapon === 'blade' ? '#d9e4e8' : '#9b5de5'
            if (isAttacking) {
              pixel(x + 36, y - 28, 28, 7, weaponColor)
            } else {
              pixel(x + 28, y - 18, 16, 5, weaponColor)
            }
          }
        }

        // Name tag
        ctx.font = 'bold 9px monospace'
        ctx.fillStyle = c
        ctx.textAlign = 'center'
        ctx.fillText(name.slice(0, 10), x + 18, y - 44)
        ctx.restore()
      }

      // Draw Remote Players (Only actual connected real players)
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
        ctx.fillStyle = 'rgba(249, 65, 68, 0.4)'
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
          pixel(x + 10, y - 40, 13, 40, '#58b368')
          pixel(x, y - 25, 11, 9, '#58b368')
          pixel(x + 26, y - 30, 10, 9, '#58b368')
        } else if (o.type === 'rock') {
          pixel(x, y - 19, 36, 19, '#a1887f')
        } else if (o.type === 'bush') {
          pixel(x, y - 21, 48, 21, '#2a9d5b')
          pixel(x + 8, y - 31, 23, 12, '#3bab64')
        } else if (o.type === 'box') {
          pixel(x, y - 30, 34, 30, '#b87942')
          pixel(x + 5, y - 25, 24, 4, '#e9c46a')
        } else if (o.type === 'bird') {
          pixel(x, y - 14, 28, 8, '#ef476f')
          pixel(x + 8, y - 23, 7, 9, '#ef476f')
        } else if (o.type === 'wolf') {
          pixel(x, y - 22, 40, 17, '#9b5de5')
          pixel(x + 28, y - 33, 15, 15, '#9b5de5')
        }
      })

      // Draw Pickups
      g.pickups.forEach(p => {
        const x = px + p.x - g.x
        if (x > -60 && x < w + 60 && !p.picked) {
          pixel(x, h * 0.76 - 12, 30, 6, '#f9c74f')
          pixel(x + 9, h * 0.76 - 26, 12, 15, p.weapon === 'blade' ? '#d9e4e8' : '#9b5de5')
        }
      })

      // Finish Signal Flare (at 8200m)
      const finishX = px + 8200 - g.x
      if (finishX > -100 && finishX < w + 200) {
        ctx.fillStyle = '#e9c46a'
        ctx.fillRect(finishX, h * 0.2, 5, h * 0.56)
        ctx.fillRect(finishX - 10, h * 0.2, 50, 24)
        ctx.fillStyle = '#f4a261'
        ctx.fillRect(finishX - 4, h * 0.205, 40, 14)
        ctx.fillStyle = '#07111c'
        ctx.font = 'bold 10px monospace'
        ctx.fillText('FINISH', finishX + 16, h * 0.2 + 11)
      }

      // HUD Track Label
      ctx.fillStyle = '#436b7e'
      ctx.font = '10px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(`ZONE // SECTOR 01 · ${players.length} RUNNERS`, 18, 24)
    },
    [players, myId]
  )

  // Main Simulation Loop
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

        // Pickups collision
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

        // Hazard collision
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
            g.message = `Hit by ${o.type.toUpperCase()}! Respawned 50m back (${g.lives} lives remaining)`
            if (g.lives === 0) g.message = 'Zero lives — continue racing to the signal flare!'
          }
        })

        // Finish line crossed
        if (g.x >= 8200 && !g.finishers.includes(myId)) {
          g.finishers.push(myId)
          const socket = socketRef.current
          if (socket) {
            socket.emit('player-finished', { lives: g.lives })
          }
          g.message = 'You crossed the signal flare!'
        }

        // Broadcast local position & state update to server at ~25-30Hz
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
            <small>REAL-TIME MULTIPLAYER SURVIVAL RUN</small>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="network">
            <i style={{ background: connected ? '#43aa8b' : '#f94144' }} />
            {connected ? 'SERVER CONNECTED' : 'CONNECTING...'}
            <span>•</span>
            {inRoom ? `ROOM: ${roomCode}` : 'NO ROOM'}
          </div>
          {inRoom && (
            <button className="rules-button" onClick={leaveRoom} title="Leave room and return to menu">
              ← LEAVE ROOM
            </button>
          )}
          <button className="rules-button" onClick={() => setShowRules(true)}>
            HOW TO PLAY <span>?</span>
          </button>
          {inRoom && (
            <button className="room-chip" onClick={() => navigator.clipboard?.writeText(roomCode)}>
              ROOM <b>{roomCode}</b> ⧉
            </button>
          )}
        </div>
      </header>

      {/* Global Error Banner (e.g. Mid-Race Reject, Room Full) */}
      {errorMessage && (
        <div
          style={{
            maxWidth: 1180,
            margin: '16px auto 0',
            padding: '12px 20px',
            background: 'rgba(249, 65, 68, 0.15)',
            border: '1px solid #f94144',
            color: '#f94144',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>
            <strong>NOTICE:</strong> {errorMessage}
          </span>
          <button
            onClick={() => setErrorMessage(null)}
            style={{ background: 'transparent', border: 'none', color: '#f94144', fontWeight: 'bold' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* PHASE 1: Room Entry Screen */}
      {phase === 'entry' && (
        <section className="lobby">
          <div className="lobby-copy">
            <p className="eyebrow">// SECTOR 01 — MULTIPLAYER BATTLEFIELD</p>
            <h1>
              RUN FAST.
              <br />
              <em>FIGHT SMART.</em>
              <br />
              SURVIVE.
            </h1>
            <p className="lede">
              A real-time multiplayer combat sprint. Rooms start empty — no placeholder bots. Enter a room code with your friends or rival runners to battle!
            </p>

            <div className="room-form" style={{ flexDirection: 'column', gap: 12 }}>
              <div>
                <label htmlFor="runnerName">CALL-SIGN (YOUR NAME)</label>
                <input
                  id="runnerName"
                  placeholder="e.g. VIPER"
                  maxLength={12}
                  value={playerName}
                  onChange={e => setPlayerName(e.target.value.toUpperCase())}
                  style={{ width: '100%', marginBottom: 12 }}
                />
              </div>

              <label htmlFor="room">ROOM CODE</label>
              <div>
                <input
                  id="room"
                  value={roomCode}
                  maxLength={8}
                  onChange={e => setRoomCode(e.target.value.toUpperCase())}
                />
                <button onClick={joinRoom} disabled={isJoining}>
                  {isJoining ? 'JOINING...' : 'ENTER ROOM'} <span>→</span>
                </button>
              </div>
            </div>

            <p className="hint">
              MIN 1-2 RUNNERS <span>•</span> MAX 8 <span>•</span> 100% REAL CONNECTED PLAYERS
            </p>
          </div>

          <div className="lobby-card">
            <div className="card-heading">
              <span>SERVER STATUS</span>
              <b style={{ color: connected ? '#43aa8b' : '#f94144' }}>
                {connected ? 'ONLINE' : 'CONNECTING...'}
              </b>
            </div>
            <h2>REAL-TIME PROTOCOL</h2>
            <p style={{ color: '#9ab0bb', fontSize: '11px', lineHeight: 1.8 }}>
              • No bots or dummy characters.
              <br />
              • Clean fresh spawn on join (5 lives, 0m start).
              <br />
              • Disconnects & exits immediately remove player entities.
              <br />
              • Empty rooms are destroyed from server memory.
            </p>
            <button className="start-button" onClick={joinRoom} disabled={isJoining}>
              {isJoining ? 'JOINING...' : 'JOIN / CREATE ROOM'} <span>↗</span>
            </button>
          </div>
        </section>
      )}

      {/* PHASE 2: Room Lobby Screen */}
      {phase === 'lobby' && (
        <section className="lobby">
          <div className="lobby-copy">
            <p className="eyebrow">// ROOM {roomCode} — READY ROOM</p>
            <h1>
              ROOM
              <br />
              <em>{roomCode}</em>
            </h1>
            <p className="lede">
              Share Room Code <strong>{roomCode}</strong> with friends. Real connected devices will populate the roster below in real-time.
            </p>
            <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
              <button className="rules-button" onClick={leaveRoom} style={{ padding: '14px 20px', fontSize: 11 }}>
                ← BACK (LEAVE ROOM)
              </button>
              <button
                className="rules-button"
                onClick={() => navigator.clipboard?.writeText(roomCode)}
                style={{ padding: '14px 20px', fontSize: 11 }}
              >
                COPY ROOM CODE ⧉
              </button>
            </div>
          </div>

          <div className="lobby-card">
            <div className="card-heading">
              <span>ROOM {roomCode}</span>
              <b>WAITING FOR HOST</b>
            </div>
            <h2>
              RUNNER ROSTER <small>{players.length}/8 RUNNERS</small>
            </h2>

            <div className="roster">
              {players.length === 0 ? (
                <div style={{ color: '#7d94a1', fontSize: '11px', padding: '12px 0' }}>
                  No runners yet. Joining room...
                </div>
              ) : (
                players.map(p => (
                  <div className="roster-row" key={p.id}>
                    <span className="avatar" style={{ backgroundColor: p.color }}>
                      {p.name[0]}
                    </span>
                    <span className="runner-name">
                      {p.name}
                      {p.id === myId && <small> YOU {p.isHost && '· HOST'}</small>}
                      {p.id !== myId && p.isHost && <small> HOST</small>}
                    </span>
                    <span className="ready">CONNECTED</span>
                  </div>
                ))
              )}
            </div>

            {isHost ? (
              <button className="start-button" onClick={startRace}>
                START ROUND ({players.length} RUNNER{players.length > 1 ? 'S' : ''}) <span>↗</span>
              </button>
            ) : (
              <div
                style={{
                  textAlign: 'center',
                  padding: 16,
                  background: 'rgba(23, 52, 70, 0.4)',
                  color: '#7d94a1',
                  fontSize: 11,
                  border: '1px solid #244050',
                }}
              >
                WAITING FOR HOST TO START RUN...
              </div>
            )}
            <p className="transport-note">
              STATUS: REAL-TIME WEBSOCKET SYNC
              <br />
              <span>Zero dummy bots — active live runners only</span>
            </p>
          </div>
        </section>
      )}

      {/* PHASE 3: Live Race Screen */}
      {phase === 'race' && (
        <section className="game-layout">
          <div className="race-column">
            <div className="race-header">
              <div>
                <p className="eyebrow">// LIVE ROUND · ROOM {roomCode}</p>
                <h1>{g.message}</h1>
              </div>
              <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
                <button
                  className="rules-button"
                  onClick={leaveRoom}
                  style={{ padding: '8px 12px' }}
                >
                  ← EXIT RUN
                </button>
                <div className="distance">
                  <span>PROGRESS</span>
                  <strong>{Math.min(100, Math.round(g.x / 82))}%</strong>
                </div>
              </div>
            </div>

            <div className="canvas-frame">
              <canvas ref={canvasRef} aria-label="Pixel Pursuit multiplayer race track" />
              <div className="scanline" />
            </div>

            <div className="control-bar">
              <div className="key-hint">
                <kbd>A/D</kbd>
                <span>MOVE</span>
              </div>
              <div className="key-hint">
                <kbd>SHIFT</kbd>
                <span>SPRINT</span>
              </div>
              <div className="key-hint">
                <kbd>SPACE</kbd>
                <span>JUMP</span>
              </div>
              <div className="key-hint">
                <kbd>S</kbd>
                <span>HIDE</span>
              </div>
              <div className="key-hint">
                <kbd>F</kbd>
                <span>ATTACK</span>
              </div>

              <div className="hide-meter">
                <span>HIDE METER {Math.round(g.hideMeter)}%</span>
                <div>
                  <i style={{ width: `${g.hideMeter}%` }} />
                </div>
              </div>
            </div>

            <div className="action-controls">
              <button onPointerDown={touch(() => move(-1))} onPointerUp={touch(stopMove)} aria-label="Move backward">
                ← BACK
              </button>
              <button onPointerDown={touch(() => move(1))} onPointerUp={touch(stopMove)} aria-label="Move forward">
                FORWARD →
              </button>
              <button onPointerDown={touch(() => move(1, true))} onPointerUp={touch(stopMove)} aria-label="Sprint">
                SPRINT
              </button>
              <button onPointerDown={touch(jump)} aria-label="Jump">
                JUMP
              </button>
              <button onPointerDown={touch(hide)} aria-label="Hide">
                HIDE
              </button>
              <button onPointerDown={touch(attack)} aria-label="Attack">
                ATTACK
              </button>
            </div>
          </div>

          <aside className="race-sidebar">
            <section className="sidebar-section">
              <div className="card-heading">
                <span>LIVE ROSTER ({players.length})</span>
                <b>TOP 3 PODIUM</b>
              </div>
              <div className="live-list">
                {players.map((p, i) => (
                  <div className={`live-row ${p.id === myId ? 'current' : ''}`} key={p.id}>
                    <span className="rank">{p.rank ? `#${p.rank}` : `0${i + 1}`}</span>
                    <span className="avatar" style={{ backgroundColor: p.color }}>
                      {p.name[0]}
                    </span>
                    <div>
                      <b>
                        {p.name} {p.id === myId && '(YOU)'}
                      </b>
                      <small>
                        {p.status} · {p.weapon ? p.weapon.toUpperCase() : 'UNARMED'}
                      </small>
                    </div>
                    <span className="hearts">
                      {'♥'.repeat(clamp(p.lives ?? 5, 0, 5))}
                      <i>{'♥'.repeat(5 - clamp(p.lives ?? 5, 0, 5))}</i>
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="sidebar-section tips">
              <h2>TACTICAL INTEL</h2>
              <p>Cover in bushes hides you from rival sight & ambush strikes.</p>
              <p>Weapons (Bat / Blade) deal melee damage and push competitors back 40m.</p>
              <p>Hitting hazards costs 1 life and pushes you back 50m.</p>
              <p>Top 3 runners to reach the signal flare make the podium.</p>
            </section>
          </aside>
        </section>
      )}

      {/* PHASE 4: Results Screen */}
      {phase === 'results' && (
        <div className="result-overlay">
          <div className="result-card">
            <p className="eyebrow">// SIGNAL FLARE REACHED</p>
            <h2>PODIUM COMPLETE</h2>
            <p>The match concluded as the top runners crossed the sector signal flare.</p>

            <div className="podium">
              {players
                .filter(p => p.rank)
                .sort((a, b) => (a.rank || 9) - (b.rank || 9))
                .map(p => (
                  <div key={p.id}>
                    <strong>#{p.rank}</strong>
                    <span className="avatar" style={{ backgroundColor: p.color }}>
                      {p.name[0]}
                    </span>
                    <b>
                      {p.name} {p.id === myId && '(YOU)'}
                    </b>
                    <small>{p.lives} lives remaining</small>
                  </div>
                ))}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              {isHost && (
                <button className="start-button" onClick={resetRace} style={{ flex: 1 }}>
                  PLAY AGAIN <span>↗</span>
                </button>
              )}
              <button className="rules-button" onClick={leaveRoom} style={{ flex: 1, padding: 14 }}>
                ← BACK TO ROOMS
              </button>
            </div>
          </div>
        </div>
      )}

      {/* HOW TO PLAY MODAL */}
      {showRules && (
        <div className="rules-overlay" role="dialog" aria-modal="true" onClick={() => setShowRules(false)}>
          <section className="rules-card" onClick={e => e.stopPropagation()}>
            <div className="card-heading">
              <span>SURVIVAL MANUAL // COMBAT EDITION</span>
              <button className="close-button" onClick={() => setShowRules(false)} aria-label="Close rules">
                ×
              </button>
            </div>
            <p className="eyebrow">// HOW TO PLAY</p>
            <h2>RUN. FIGHT. HIDE.</h2>
            <p className="rules-intro">
              Race your rivals in real-time. Reach the signal flare at 8200m. The first three finishers lock the podium!
            </p>

            <div className="rules-grid">
              <div>
                <h3>MOVEMENT</h3>
                <p>
                  <kbd>A/D</kbd> or Arrows move. Hold <kbd>SHIFT</kbd> to sprint. <kbd>SPACE</kbd>/<kbd>W</kbd> jumps.
                </p>
                <p>
                  <kbd>S</kbd>/<kbd>DOWN</kbd> hides in cover (bushes) and drains the hide meter.
                </p>
              </div>
              <div>
                <h3>COMBAT</h3>
                <p>
                  Start unarmed. Walk over a bat or blade to equip it, then press <kbd>F</kbd> or <kbd>E</kbd> to swing.
                </p>
                <p>Ambushing from cover deals direct damage to nearby runners.</p>
              </div>
              <div>
                <h3>LIVES & HAZARDS</h3>
                <p>
                  Cacti, rocks, birds, wolves cost one life and respawn you 50m back. Zero lives lets you keep running as a ghost.
                </p>
                <p>Bushes and boxes are safe cover.</p>
              </div>
            </div>

            <button className="start-button" onClick={() => setShowRules(false)}>
              CLOSE MANUAL <span>↗</span>
            </button>
          </section>
        </div>
      )}
    </main>
  )
}
