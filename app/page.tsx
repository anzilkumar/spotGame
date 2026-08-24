'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'

type Weapon = 'gun' | 'unarmed'
type Player = {
  id: string
  name: string
  color: string
  lives: number
  bulletHits: number
  progress: number
  status: 'RUNNING' | 'FINISHED' | 'OUT'
  weapon: Weapon
  x: number
  y: number
  vx: number
  vy: number
  facing: number // 1 = facing forward (right), -1 = facing backward (left)
  hidden: boolean
  attack: number
  rank?: number | null
  isHost?: boolean
}

type Hazard = {
  id: string
  x: number
  type: 'thorns' | 'bird' | 'cactus' | 'rock' | 'bush' | 'box'
  lane: number
  hit?: boolean
}

type Bullet = {
  id: string
  shooterId: string
  x: number
  y: number
  vx: number
  distance: number
  active: boolean
}

type LocalGame = {
  running: boolean
  x: number
  vx: number
  y: number
  vy: number
  facing: number
  hidden: boolean
  hideMeter: number
  hideCooldown: number
  weapon: Weapon
  attack: number
  invincible: number
  flash: number
  lives: number
  bulletHits: number // 2 hits = 1 life lost
  bullets: Bullet[]
  hazards: Hazard[]
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

function generateTrack(seed: number): { hazards: Hazard[] } {
  const rand = createPRNG(seed)
  const hazards: Hazard[] = []
  // Obstacles: thorns (ground - jump), bird (air - jump or crouch), cactus (jump), rock (jump), bush (cover), box (cover)
  const types: Hazard['type'][] = ['thorns', 'bird', 'cactus', 'rock', 'bush', 'box']

  let currentX = 500
  let hId = 0
  while (currentX < 8100) {
    currentX += 240 + Math.floor(rand() * 380)
    if (currentX >= 8100) break
    const type = types[Math.floor(rand() * types.length)]
    // Birds fly high, thorns and cacti on ground
    const lane = type === 'bird' ? 1 : 0
    hazards.push({ id: `h_${hId++}`, x: currentX, type, lane, hit: false })
  }

  return { hazards }
}

function initialGame(): LocalGame {
  return {
    running: false,
    x: 0,
    vx: 0,
    y: 0,
    vy: 0,
    facing: 1, // Facing forward (right)
    hidden: false,
    hideMeter: 100,
    hideCooldown: 0,
    weapon: 'gun', // Starts armed with Gun
    attack: 0,
    invincible: 0,
    flash: 0,
    lives: 5,
    bulletHits: 0, // 2 hits reduce 1 life
    bullets: [],
    hazards: [],
    finishers: [],
    message: 'READY TO SPRINT & SHOOT',
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
  const myIdRef = useRef('')
  const gameRef = useRef<LocalGame>(initialGame())
  const lastEmitRef = useRef(0)

  const [connected, setConnected] = useState(false)
  const [inRoom, setInRoom] = useState(false)
  const [roomCode, setRoomCode] = useState('SPR01')
  const [playerName, setPlayerName] = useState('')
  const [myId, setMyId] = useState('')
  const [phase, setPhase] = useState<'entry' | 'lobby' | 'race' | 'eliminated' | 'results'>('entry')
  const [players, setPlayers] = useState<Player[]>([])
  const [showRules, setShowRules] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isJoining, setIsJoining] = useState(false)
  const [isMobileSprinting, setIsMobileSprinting] = useState(false)
  const [, redraw] = useState(0)

  const update = useCallback(() => redraw(n => n + 1), [])

  // Socket Connection Lifecycle
  useEffect(() => {
    const socket = io({
      transports: ['polling', 'websocket'], // Polling first guarantees instant connection on cloud hosts
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      autoConnect: true,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      setErrorMessage(null)
    })

    socket.on('connect_error', () => {
      setConnected(false)
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
        myIdRef.current = res.player.id
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
        message: 'GO! Run, hide, and fire at rivals!',
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
              facing: data.facing ?? p.facing ?? 1,
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

    // Remote bullet fired
    socket.on('bullet-fired', (data: { id: string; shooterId: string; x: number; y: number; vx: number; facing: number }) => {
      const g = gameRef.current
      if (data.shooterId !== socket.id && data.shooterId !== myIdRef.current) {
        g.bullets.push({
          id: data.id,
          shooterId: data.shooterId,
          x: data.x,
          y: data.y,
          vx: data.vx,
          distance: 0,
          active: true,
        })
      }
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

  // Join Room Action (with Auto-Connect resilience)
  const joinRoom = useCallback(() => {
    const socket = socketRef.current
    if (!socket) return

    let cleanRoom = roomCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!cleanRoom.startsWith('SPR')) {
      cleanRoom = 'SPR' + cleanRoom.replace(/^S?P?R?/, '')
    }
    cleanRoom = cleanRoom.slice(0, 8) || 'SPR01'
    setRoomCode(cleanRoom)
    setIsJoining(true)
    setErrorMessage(null)

    const executeJoin = () => {
      socket.emit(
        'join-room',
        { roomId: cleanRoom, name: playerName.trim() || undefined },
        (res: { success: boolean; code?: string; message?: string; player?: Player; room?: { id: string; status: 'lobby' | 'in-progress' | 'results'; players: Player[] } }) => {
          setIsJoining(false)
          if (res && res.success && res.player && res.room) {
            myIdRef.current = res.player.id
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
    }

    if (!socket.connected) {
      setErrorMessage('Connecting to game server... please wait a few seconds.')
      socket.connect()
      socket.once('connect', () => {
        setConnected(true)
        setErrorMessage(null)
        executeJoin()
      })
    } else {
      executeJoin()
    }
  }, [roomCode, playerName])

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

  // Return to Lobby after elimination
  const returnToLobby = useCallback(() => {
    setPhase('lobby')
  }, [])

  // Start Race Action
  const startRace = useCallback(() => {
    const socket = socketRef.current
    if (socket) {
      socket.emit('start-race', { roomId: roomCode })
    }
  }, [roomCode])

  // Reset Race Action
  const resetRace = useCallback(() => {
    const socket = socketRef.current
    if (socket) {
      socket.emit('reset-race', { roomId: roomCode })
    }
  }, [roomCode])

  const isSprintingRef = useRef(false)

  // Jump (clear ground thorns, cacti, rocks, or airborne birds)
  const jump = useCallback(() => {
    const g = gameRef.current
    if (g.running && g.y === 0) g.vy = 650
  }, [])

  // Move forward / backward with turning orientation & sprint support
  const move = useCallback((direction: number, forceSprint?: boolean) => {
    const g = gameRef.current
    if (g.running) {
      const isSprint = forceSprint ?? isSprintingRef.current
      g.vx = direction * (isSprint ? 440 : 260)
      if (direction > 0) g.facing = 1 // Facing forward (right)
      if (direction < 0) g.facing = -1 // Facing backward (left)
    }
  }, [])

  // Toggle Sprint (Spirit) Mode on/off
  const toggleSprint = useCallback(() => {
    setIsMobileSprinting(prev => {
      const next = !prev
      isSprintingRef.current = next
      const g = gameRef.current
      if (g.running && g.vx !== 0) {
        const dir = g.vx > 0 ? 1 : -1
        g.vx = dir * (next ? 440 : 260)
      }
      return next
    })
  }, [])

  const stopMove = useCallback(() => {
    const g = gameRef.current
    if (g.running) g.vx = 0
  }, [])

  // Hide in Box / Bush / Duck
  const hide = useCallback(() => {
    const g = gameRef.current
    if (g.running && g.hideCooldown <= 0 && g.hideMeter > 15) {
      g.hidden = !g.hidden
      g.hideCooldown = g.hidden ? 2.2 : 0.4
      g.message = g.hidden ? 'In cover — ready for ambush!' : 'Stepped out of cover'
    }
  }, [])

  // Fire Gun with visible bullets
  const shootGun = useCallback(() => {
    const g = gameRef.current
    if (g.running && g.attack <= 0) {
      g.attack = 0.22 // Rapid fire cooldown
      const bulletSpeed = 950 * g.facing
      const bulletX = g.x + (g.facing === 1 ? 38 : -8)
      const bulletY = 400 * 0.76 - g.y - 28

      const newBullet: Bullet = {
        id: `b_${myId}_${Date.now()}_${Math.random()}`,
        shooterId: myId,
        x: bulletX,
        y: bulletY,
        vx: bulletSpeed,
        distance: 0,
        active: true,
      }

      g.bullets.push(newBullet)
      g.message = 'BANG! Gun fired!'

      // Reveal from cover when firing
      g.hidden = false

      const socket = socketRef.current
      if (socket) {
        socket.emit('player-shoot', {
          id: newBullet.id,
          x: bulletX,
          y: bulletY,
          vx: bulletSpeed,
          facing: g.facing,
        })
      }
    }
  }, [myId])

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
      if (e.code === 'KeyF' || e.code === 'KeyE') shootGun()

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
  }, [phase, shootGun, hide, jump, move, stopMove])

  // Clear Vector-Style Canvas Drawing
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      const g = gameRef.current
      ctx.clearRect(0, 0, w, h)

      // High-contrast dark arena background
      ctx.fillStyle = '#09101d'
      ctx.fillRect(0, 0, w, h)

      // Horizon Terrain Line
      ctx.fillStyle = '#142336'
      ctx.fillRect(0, h * 0.52, w, h * 0.48)

      // Solid Bold Yellow Ground Line
      ctx.fillStyle = '#ffd600'
      ctx.fillRect(0, h * 0.76, w, 5)

      // Ground Grid Lines
      ctx.strokeStyle = '#233f58'
      ctx.lineWidth = 2.5
      for (let x = -((g.x * 1.5) % 40); x < w; x += 40) {
        ctx.beginPath()
        ctx.moveTo(x, h * 0.81)
        ctx.lineTo(x + 18, h * 0.81)
        ctx.stroke()
      }

      const px = 160
      const base = h * 0.76 - g.y

      // Smooth Vector Runner Function with Facing Direction (Turn around)
      const drawVectorRunner = (
        x: number,
        y: number,
        color: string,
        name: string,
        isHidden: boolean,
        isOut: boolean,
        isAttacking: boolean,
        distanceX: number,
        isJumping: boolean,
        facingDir: number, // 1 = facing right, -1 = facing left
        isLocal: boolean
      ) => {
        if (isOut) return

        // Ground shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
        ctx.beginPath()
        ctx.ellipse(x + 16, h * 0.76 + 3, 20, 5, 0, 0, Math.PI * 2)
        ctx.fill()

        if (isHidden) {
          // In Cover (Box/Bush stealth stance)
          ctx.save()
          ctx.fillStyle = '#b45309'
          ctx.strokeStyle = '#000000'
          ctx.lineWidth = 2.5
          ctx.fillRect(x - 4, y - 36, 40, 36)
          ctx.strokeRect(x - 4, y - 36, 40, 36)

          // Crate crossbar
          ctx.strokeStyle = '#ffd600'
          ctx.beginPath()
          ctx.moveTo(x - 4, y - 36)
          ctx.lineTo(x + 36, y)
          ctx.stroke()

          // Peeking helmet
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(x + 16, y - 40, 9, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
          ctx.restore()
        } else {
          ctx.save()
          // Flip character based on facing direction!
          ctx.translate(x + 16, y)
          ctx.scale(facingDir >= 0 ? 1 : -1, 1)
          ctx.translate(-(x + 16), -y)

          const runCycle = isJumping ? 0.8 : (distanceX / 14) % (Math.PI * 2)
          const legSwing = Math.sin(runCycle) * 14
          const armSwing = Math.cos(runCycle) * 12

          // --- LEGS ---
          ctx.lineWidth = 6
          ctx.lineCap = 'round'
          ctx.strokeStyle = '#000000'

          // Left Leg (Back)
          ctx.beginPath()
          ctx.moveTo(x + 12, y - 12)
          ctx.lineTo(x + 12 - legSwing, y + 16)
          ctx.stroke()

          // Right Leg (Front)
          ctx.beginPath()
          ctx.moveTo(x + 20, y - 12)
          ctx.lineTo(x + 20 + legSwing, y + 16)
          ctx.stroke()

          // --- TORSO ---
          ctx.fillStyle = color
          ctx.strokeStyle = '#000000'
          ctx.lineWidth = 2.5

          // Body suit
          ctx.beginPath()
          ctx.roundRect(x + 6, y - 32, 20, 24, 6)
          ctx.fill()
          ctx.stroke()

          // Athletic central stripe
          ctx.fillStyle = '#000000'
          ctx.fillRect(x + 14, y - 32, 4, 24)

          // --- HEAD & VISOR ---
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(x + 16, y - 44, 11, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()

          // Cyber Visor
          ctx.fillStyle = '#000000'
          ctx.beginPath()
          ctx.roundRect(x + 16, y - 48, 12, 8, 3)
          ctx.fill()

          ctx.fillStyle = '#ffd600'
          ctx.fillRect(x + 18, y - 46, 8, 4)

          // --- ARMS & GUN ---
          ctx.strokeStyle = '#000000'
          ctx.lineWidth = 5

          // Left Arm (Back)
          ctx.beginPath()
          ctx.moveTo(x + 8, y - 26)
          ctx.lineTo(x + 4 - armSwing, y - 12)
          ctx.stroke()

          // Right Arm (Holding Gun)
          ctx.beginPath()
          ctx.moveTo(x + 24, y - 26)
          ctx.lineTo(x + 32, y - 24)
          ctx.stroke()

          // --- GUN SPRITE ---
          ctx.fillStyle = '#1e293b'
          ctx.strokeStyle = '#000000'
          ctx.lineWidth = 2
          // Gun body & barrel pointing forward
          ctx.fillRect(x + 28, y - 28, 16, 7)
          ctx.strokeRect(x + 28, y - 28, 16, 7)
          // Gun grip
          ctx.fillRect(x + 30, y - 21, 5, 8)
          ctx.strokeRect(x + 30, y - 21, 5, 8)

          // Muzzle Flash when firing
          if (isAttacking) {
            ctx.fillStyle = '#ffd600'
            ctx.beginPath()
            ctx.arc(x + 48, y - 25, 7, 0, Math.PI * 2)
            ctx.fill()
          }

          ctx.restore()
        }

        // --- NAME BADGE (Unflipped, always readable) ---
        ctx.save()
        ctx.font = 'bold 11px Space Grotesk, monospace'
        const textWidth = ctx.measureText(name).width
        const badgeW = textWidth + 18
        const badgeX = x + 16 - badgeW / 2
        const badgeY = y - 66

        ctx.fillStyle = '#ffffff'
        ctx.strokeStyle = '#000000'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.roundRect(badgeX, badgeY, badgeW, 18, 4)
        ctx.fill()
        ctx.stroke()

        // Color indicator dot
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(badgeX + 8, badgeY + 9, 3.5, 0, Math.PI * 2)
        ctx.fill()

        // Text
        ctx.fillStyle = '#000000'
        ctx.textAlign = 'left'
        ctx.fillText(name, badgeX + 14, badgeY + 13)
        ctx.restore()
      }

      // Draw Remote Players (Only visible if within sight or not hidden, unless within 20m ambush zone)
      players.forEach(p => {
        if (p.id === myId) return
        if (p.lives <= 0 || p.status === 'OUT') return

        const screenX = px + (p.x - g.x)
        if (screenX < -120 || screenX > w + 120) return
        const screenY = h * 0.76 - (p.y || 0)

        // 20m proximity detection (~160px)
        const isNear = Math.abs(p.x - g.x) < 160

        drawVectorRunner(
          screenX,
          screenY,
          p.color,
          p.name,
          p.hidden && !isNear, // Revealed if within 20m combat proximity
          false,
          p.attack > 0,
          p.x,
          (p.y || 0) > 0,
          p.facing ?? 1,
          false
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

      if (g.lives > 0) {
        drawVectorRunner(
          px,
          base,
          myColor,
          myName,
          g.hidden,
          false,
          g.attack > 0,
          g.x,
          g.y > 0,
          g.facing,
          true
        )
      }

      // --- DRAW VISIBLE BULLETS (Laser Projectiles) ---
      g.bullets.forEach(b => {
        if (!b.active) return
        const bulletScreenX = px + (b.x - g.x)
        if (bulletScreenX < -50 || bulletScreenX > w + 50) return

        ctx.save()
        // Glowing Laser Bullet Capsule
        ctx.fillStyle = '#ffd600'
        ctx.strokeStyle = '#000000'
        ctx.lineWidth = 1.5

        ctx.beginPath()
        ctx.roundRect(bulletScreenX - 7, b.y - 3, 16, 6, 3)
        ctx.fill()
        ctx.stroke()

        // Bullet Energy Trail
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(bulletScreenX - (b.vx > 0 ? 12 : -4), b.y - 1.5, 8, 3)
        ctx.restore()
      })

      // --- DRAW OBSTACLES ---
      g.hazards.forEach(o => {
        const x = px + o.x - g.x
        if (x < -100 || x > w + 100) return
        const y = h * 0.76 - (o.lane ? 60 : 0)

        ctx.save()
        if (o.type === 'thorns') {
          // Sharp Ground Thorns / Spikes (Jump over)
          ctx.fillStyle = '#991b1b'
          ctx.strokeStyle = '#000000'
          ctx.lineWidth = 2
          ctx.beginPath()
          // Multiple sharp thorns sticking up from the ground
          ctx.moveTo(x, y)
          ctx.lineTo(x + 8, y - 24)
          ctx.lineTo(x + 16, y)
          ctx.lineTo(x + 24, y - 28)
          ctx.lineTo(x + 32, y)
          ctx.lineTo(x + 40, y - 22)
          ctx.lineTo(x + 48, y)
          ctx.closePath()
          ctx.fill()
          ctx.stroke()
        } else if (o.type === 'bird') {
          // Airborne Flying Bird (Jump over or duck/prone under)
          ctx.fillStyle = '#ef4444'
          ctx.strokeStyle = '#000000'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(x + 14, y - 16, 11, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
          // Flapping Wings
          ctx.beginPath()
          ctx.moveTo(x + 4, y - 16)
          ctx.lineTo(x - 8, y - 30)
          ctx.lineTo(x + 10, y - 22)
          ctx.lineTo(x + 26, y - 30)
          ctx.lineTo(x + 18, y - 16)
          ctx.fill()
          ctx.stroke()
        } else if (o.type === 'cactus') {
          // Large Cactus (Jump over)
          ctx.fillStyle = '#00c853'
          ctx.strokeStyle = '#000000'
          ctx.lineWidth = 2.5
          ctx.beginPath()
          ctx.roundRect(x + 10, y - 48, 16, 48, 6)
          ctx.roundRect(x - 4, y - 36, 14, 12, 4)
          ctx.roundRect(x - 4, y - 36, 8, 20, 4)
          ctx.roundRect(x + 24, y - 40, 14, 12, 4)
          ctx.roundRect(x + 30, y - 40, 8, 22, 4)
          ctx.fill()
          ctx.stroke()
        } else if (o.type === 'rock') {
          // Boulder (Jump over)
          ctx.fillStyle = '#64748b'
          ctx.strokeStyle = '#000000'
          ctx.lineWidth = 2.5
          ctx.beginPath()
          ctx.moveTo(x, y)
          ctx.lineTo(x + 8, y - 26)
          ctx.lineTo(x + 28, y - 32)
          ctx.lineTo(x + 44, y - 18)
          ctx.lineTo(x + 40, y)
          ctx.closePath()
          ctx.fill()
          ctx.stroke()
        } else if (o.type === 'box') {
          // Wooden Box Cover (Hide and Ambush)
          ctx.fillStyle = '#b45309'
          ctx.strokeStyle = '#000000'
          ctx.lineWidth = 2.5
          ctx.fillRect(x, y - 36, 36, 36)
          ctx.strokeRect(x, y - 36, 36, 36)
          ctx.strokeStyle = '#ffd600'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(x, y - 36)
          ctx.lineTo(x + 36, y)
          ctx.stroke()
        } else if (o.type === 'bush') {
          // Bush Cover (Hide and Ambush)
          ctx.fillStyle = '#00c853'
          ctx.strokeStyle = '#000000'
          ctx.lineWidth = 2.5
          ctx.beginPath()
          ctx.arc(x + 10, y - 18, 16, 0, Math.PI * 2)
          ctx.arc(x + 26, y - 24, 18, 0, Math.PI * 2)
          ctx.arc(x + 42, y - 18, 16, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
        }
        ctx.restore()
      })

      // Finish Signal Flare (at 8200m)
      const finishX = px + 8200 - g.x
      if (finishX > -120 && finishX < w + 240) {
        ctx.save()
        ctx.fillStyle = '#ffd600'
        ctx.strokeStyle = '#000000'
        ctx.lineWidth = 3.5
        ctx.fillRect(finishX, h * 0.16, 8, h * 0.6)
        ctx.strokeRect(finishX, h * 0.16, 8, h * 0.6)

        // Banner
        ctx.fillRect(finishX - 16, h * 0.16, 70, 32)
        ctx.strokeRect(finishX - 16, h * 0.16, 70, 32)

        ctx.fillStyle = '#000000'
        ctx.font = '900 13px Space Grotesk, sans-serif'
        ctx.fillText('FINISH', finishX - 6, h * 0.16 + 21)
        ctx.restore()
      }

      // HUD Label
      ctx.fillStyle = '#ffd600'
      ctx.font = '800 11px JetBrains Mono, monospace'
      ctx.textAlign = 'left'
      ctx.fillText(`SPOTGAME // ${players.filter(p => p.status === 'RUNNING').length} RUNNERS LIVE`, 20, 28)
    },
    [players, myId]
  )

  // Main Game Loop & Bullet Collision Processing
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

      if (g.running && g.lives > 0) {
        // Player movement
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

        // --- BULLETS SIMULATION ---
        g.bullets.forEach(b => {
          if (!b.active) return
          b.x += b.vx * dt
          b.distance += Math.abs(b.vx * dt)

          // Deactivate bullet if out of range
          if (b.distance > 1100) {
            b.active = false
            return
          }

          // Check hit against local player (if bullet was fired by an opponent)
          if (b.shooterId !== myId && g.invincible <= 0) {
            const hitRadius = 36
            const playerY = 400 * 0.76 - g.y - 20
            const dx = Math.abs(b.x - g.x)
            const dy = Math.abs(b.y - playerY)

            if (dx < hitRadius && dy < hitRadius) {
              b.active = false
              g.bulletHits += 1
              g.flash = 0.3

              // 2 shots = 1 life reduction!
              if (g.bulletHits % 2 === 0) {
                g.lives = Math.max(0, g.lives - 1)
                g.x = Math.max(0, g.x - 40)
                g.invincible = 1.0
                g.message = `Shot twice! Lost 1 life! (${g.lives} lives remaining)`

                if (g.lives <= 0) {
                  g.running = false
                  setPhase('eliminated')
                  const socket = socketRef.current
                  if (socket) {
                    socket.emit('player-update', {
                      x: g.x,
                      y: g.y,
                      vx: g.vx,
                      vy: g.vy,
                      facing: g.facing,
                      lives: 0,
                      status: 'OUT',
                      progress: Math.min(100, Math.round(g.x / 82)),
                    })
                  }
                  return
                }
              } else {
                g.message = `Hit by bullet! (1 of 2 shots taken)`
              }
            }
          }
        })

        // Clean inactive bullets
        g.bullets = g.bullets.filter(b => b.active)

        // --- HAZARD COLLISION ---
        g.hazards.forEach(o => {
          const gap = o.x - g.x
          // Thorns on ground: Jump to avoid
          if (o.type === 'thorns') {
            if (gap > 0 && gap < 55 && g.y < 35 && !o.hit && g.invincible <= 0) {
              o.hit = true
              g.lives = Math.max(0, g.lives - 1)
              g.x = Math.max(0, g.x - 45)
              g.invincible = 1.2
              g.flash = 0.3
              g.message = `Hit sharp thorns! Jump to clear ground thorns! (${g.lives} lives left)`

              if (g.lives <= 0) {
                g.running = false
                setPhase('eliminated')
                const socket = socketRef.current
                if (socket) {
                  socket.emit('player-update', {
                    x: g.x,
                    y: g.y,
                    lives: 0,
                    status: 'OUT',
                    progress: Math.min(100, Math.round(g.x / 82)),
                  })
                }
              }
            }
          } else if (o.type === 'bird') {
            // Airborne Bird: Jump high or duck/prone/hide to clear
            const birdHeight = 60
            const dangerous = gap > 0 && gap < 55 && Math.abs(g.y - birdHeight) < 40 && !g.hidden
            if (dangerous && !o.hit && g.invincible <= 0) {
              o.hit = true
              g.lives = Math.max(0, g.lives - 1)
              g.x = Math.max(0, g.x - 45)
              g.invincible = 1.2
              g.flash = 0.3
              g.message = `Hit by cyber bird! Duck/hide or jump over! (${g.lives} lives left)`

              if (g.lives <= 0) {
                g.running = false
                setPhase('eliminated')
                const socket = socketRef.current
                if (socket) {
                  socket.emit('player-update', {
                    x: g.x,
                    y: g.y,
                    lives: 0,
                    status: 'OUT',
                    progress: Math.min(100, Math.round(g.x / 82)),
                  })
                }
              }
            }
          } else if (o.type === 'cactus' || o.type === 'rock') {
            // Jump over cacti and rocks
            const dangerous = gap > 0 && gap < 55 && g.y < 35
            if (dangerous && !o.hit && g.invincible <= 0) {
              o.hit = true
              g.lives = Math.max(0, g.lives - 1)
              g.x = Math.max(0, g.x - 45)
              g.invincible = 1.2
              g.flash = 0.3
              g.message = `Hit ${o.type}! Jump to clear! (${g.lives} lives left)`

              if (g.lives <= 0) {
                g.running = false
                setPhase('eliminated')
                const socket = socketRef.current
                if (socket) {
                  socket.emit('player-update', {
                    x: g.x,
                    y: g.y,
                    lives: 0,
                    status: 'OUT',
                    progress: Math.min(100, Math.round(g.x / 82)),
                  })
                }
              }
            }
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

        // Broadcast local state at ~30Hz
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
              facing: g.facing,
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
          <span className="brand-mark" style={{ background: 'var(--yellow)', color: '#000000', fontWeight: 900 }}>
            SG
          </span>
          <div>
            <strong>spotGame</strong>
            <small>ONLINE MULTIPLAYER SURVIVAL</small>
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

      {/* ================= PHASE 1: Entry Screen ================= */}
      {phase === 'entry' && (
        <section className="hero-section">
          <div className="badge-pill">ANONYMOUS & REAL-TIME MULTIPLAYER</div>

          <h1 className="hero-title">
            RUN FAST. <span className="badge-highlight">SURVIVE.</span>
          </h1>

          <p className="hero-subtitle">
            Real-time survival race with real runners, armed with guns. Jump thorns, duck birds, hide in boxes, and shoot rivals to claim the podium.
          </p>

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
                ROOM CODE (LOCKED PREFIX: SPR)
              </label>
              <input
                id="room"
                className="neo-input"
                value={roomCode}
                maxLength={8}
                onChange={e => {
                  let val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
                  if (!val.startsWith('SPR')) {
                    val = 'SPR' + val.replace(/^S?P?R?/, '')
                  }
                  setRoomCode(val.slice(0, 8))
                }}
                onKeyDown={e => {
                  const target = e.currentTarget
                  if (
                    e.key === 'Backspace' &&
                    target.selectionStart !== null &&
                    target.selectionStart <= 3 &&
                    target.selectionEnd !== null &&
                    target.selectionEnd <= 3
                  ) {
                    e.preventDefault()
                  }
                }}
              />
            </div>

            <button className="hero-cta-button" onClick={joinRoom} disabled={isJoining}>
              {isJoining ? 'CONNECTING...' : 'START RUN'} <span>→</span>
            </button>
          </div>

          <div className="footer-bar" style={{ width: '100%', marginTop: 'auto' }}>
            <div className="footer-item">🔫 2 SHOTS = 1 LIFE DAMAGE</div>
            <div className="footer-item">📦 HIDE IN BOXES & BUSHES</div>
            <div className="footer-item">🦅 JUMP THORNS & DUCK BIRDS</div>
            <div className="footer-item">⚡ 100% LIVE MULTIPLAYER</div>
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

            <button className="hero-cta-button" onClick={startRace}>
              START ROUND ({players.length} RUNNER{players.length > 1 ? 'S' : ''}) <span>→</span>
            </button>
          </div>
        </section>
      )}

      {/* ================= PHASE 3: Live Race with Screen HUD Life Display ================= */}
      {phase === 'race' && (
        <section className="game-layout">
          <div>
            {/* Top In-Game Screen HUD with Visible Lives Bar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
                padding: '14px 18px',
                background: '#ffffff',
                border: '3px solid #000000',
                boxShadow: '5px 5px 0px #000000',
                marginBottom: 14,
              }}
            >
              {/* LIVES DISPLAY DIRECTLY ON SCREEN */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ fontFamily: 'JetBrains Mono', fontWeight: 900, fontSize: '13px', textTransform: 'uppercase' }}>
                  LIVES:
                </div>
                <div style={{ display: 'flex', gap: 4, fontSize: '20px', color: '#ff3b30' }}>
                  {[...Array(5)].map((_, i) => (
                    <span key={i} style={{ color: i < g.lives ? '#ff3b30' : '#cbd5e1' }}>
                      {i < g.lives ? '♥' : '♡'}
                    </span>
                  ))}
                </div>

                {/* HIT SHIELD INDICATOR (2 Shots = 1 Life) */}
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px',
                    background: g.bulletHits % 2 === 1 ? '#fffae0' : '#f1f5f9',
                    border: '1.5px solid #000000',
                    fontFamily: 'JetBrains Mono',
                    fontSize: '10px',
                    fontWeight: 800,
                  }}
                >
                  <span>SHIELD:</span>
                  <span style={{ color: g.bulletHits % 2 === 1 ? '#ff3b30' : '#00c853' }}>
                    {g.bulletHits % 2 === 1 ? '1/2 SHOTS' : '2/2 FULL'}
                  </span>
                </div>
              </div>

              {/* ACTION MESSAGE & DISTANCE */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{ fontWeight: 800, fontSize: '13px', color: '#000000' }}>
                  {g.message}
                </div>
                <div className="progress-badge">
                  <span>PROGRESS</span>
                  <strong>{Math.min(100, Math.round(g.x / 82))}%</strong>
                </div>
                <button className="neo-button" onClick={leaveRoom} style={{ padding: '6px 10px', fontSize: '10px' }}>
                  ← EXIT
                </button>
              </div>
            </div>

            {/* Game Canvas Frame */}
            <div className="canvas-frame">
              <canvas ref={canvasRef} aria-label="Pixel Pursuit race track" />
            </div>

            {/* Controls Bar */}
            <div className="controls-row">
              <div className="key-pill">
                <kbd>A/D</kbd>
                <span>TURN & MOVE</span>
              </div>
              <div className="key-pill">
                <kbd>SHIFT</kbd>
                <span>SPRINT</span>
              </div>
              <div className="key-pill">
                <kbd>SPACE/W</kbd>
                <span>JUMP</span>
              </div>
              <div className="key-pill">
                <kbd>S/DOWN</kbd>
                <span>HIDE IN BOX/BUSH</span>
              </div>
              <div className="key-pill" style={{ background: '#ffd600' }}>
                <kbd>F/E</kbd>
                <span>🔫 FIRE GUN</span>
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

            {/* Mobile & Tablet Ergonomic Touch Gamepad Controls */}
            <div className="mobile-gamepad-container">
              <div className="gamepad-row">
                {/* Left Side: Movement D-Pad (Left Arrow, Jump in between, Right Arrow) */}
                <div className="dpad-container">
                  <button
                    className="dpad-btn"
                    onPointerDown={touch(() => move(-1))}
                    onPointerUp={touch(stopMove)}
                    onPointerLeave={touch(stopMove)}
                    onPointerCancel={touch(stopMove)}
                    aria-label="Move and face left / backward"
                  >
                    ◀
                  </button>

                  {/* Jump Arrow in between Left and Right! */}
                  <button
                    className="dpad-btn dpad-jump-btn"
                    onPointerDown={touch(jump)}
                    aria-label="Jump over hazards"
                  >
                    <span style={{ fontSize: '18px', lineHeight: 1 }}>▲</span>
                    <span style={{ fontSize: '8px', fontWeight: 900, marginTop: 1 }}>JUMP</span>
                  </button>

                  <button
                    className="dpad-btn"
                    onPointerDown={touch(() => move(1))}
                    onPointerUp={touch(stopMove)}
                    onPointerLeave={touch(stopMove)}
                    onPointerCancel={touch(stopMove)}
                    aria-label="Move and face right / forward"
                  >
                    ▶
                  </button>
                </div>

                {/* Right Side: Action Cluster (Fire, Hide, Sprint ON/OFF) */}
                <div className="action-cluster">
                  <button
                    className="action-btn-circle action-btn-fire"
                    onPointerDown={touch(shootGun)}
                    aria-label="Fire Gun"
                  >
                    <span style={{ fontSize: '20px' }}>🔫</span>
                    <span style={{ fontSize: '10px', fontWeight: 900 }}>FIRE</span>
                  </button>

                  <button
                    className="action-btn-circle action-btn-hide"
                    onPointerDown={touch(hide)}
                    aria-label="Hide in Box or Bush"
                  >
                    <span style={{ fontSize: '15px' }}>📦</span>
                    <span style={{ fontSize: '9px', fontWeight: 900 }}>HIDE</span>
                  </button>

                  <button
                    className={`action-btn-circle action-btn-sprint ${isMobileSprinting ? 'active' : ''}`}
                    onClick={toggleSprint}
                    aria-label="Toggle Sprint Mode"
                  >
                    <span style={{ fontSize: '15px' }}>⚡</span>
                    <span style={{ fontSize: '8px', fontWeight: 900, lineHeight: 1 }}>
                      {isMobileSprinting ? 'SPRINT: ON' : 'SPRINT: OFF'}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <aside className="neo-card" style={{ height: 'fit-content' }}>
            <div className="card-header-line">
              <span>LIVE STANDINGS</span>
              <span>PODIUM RUN</span>
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
                      {p.status} · {p.progress}%
                    </div>
                  </div>
                  <div style={{ color: 'var(--red)', fontSize: '13px', letterSpacing: '1px' }}>
                    {p.lives > 0 ? '♥'.repeat(clamp(p.lives ?? 5, 0, 5)) : <span style={{ color: '#000', fontSize: '10px', fontWeight: 800 }}>OUT</span>}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 24, paddingTop: 16, borderTop: '2px solid #000' }}>
              <div style={{ fontFamily: 'JetBrains Mono', fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', marginBottom: 8 }}>
                TACTICAL GUIDE
              </div>
              <p style={{ color: 'var(--muted)', fontSize: '11px', lineHeight: 1.6, margin: 0 }}>
                • <strong>GUN COMBAT</strong>: 2 bullet hits take 1 life of the target!
                <br />
                • <strong>TURNING</strong>: Face turns with your movement direction.
                <br />
                • <strong>BOX & BUSH COVER</strong>: Hide in crates or bushes. Detected within 20m proximity!
                <br />
                • <strong>OBSTACLES</strong>: Jump ground thorns/cacti; duck/jump flying birds.
              </p>
            </div>
          </aside>
        </section>
      )}

      {/* ================= PHASE 4: Eliminated Screen (Wait in Lobby) ================= */}
      {phase === 'eliminated' && (
        <div className="neo-modal-overlay">
          <div className="neo-modal-card" style={{ maxWidth: 520, textAlign: 'center' }}>
            <div className="badge-pill" style={{ background: '#ff3b30', color: '#ffffff', borderColor: '#000000' }}>
              ALL LIVES SPENT
            </div>
            <h1 style={{ fontSize: '38px', fontWeight: 900, margin: '14px 0 12px' }}>
              YOU ARE <span className="badge-highlight" style={{ background: '#ff3b30', color: '#fff' }}>ELIMINATED.</span>
            </h1>
            <p style={{ color: 'var(--muted)', fontSize: '14px', lineHeight: 1.6, margin: '0 0 24px' }}>
              You lost all 5 lives! Please wait in the lobby — you will automatically join the next round with fresh lives when the host restarts.
            </p>

            <div className="neo-card" style={{ padding: 18, marginBottom: 24, textAlign: 'left' }}>
              <div className="card-header-line" style={{ marginBottom: 12, paddingBottom: 8 }}>
                <span>SURVIVING RUNNERS</span>
                <span>STATUS</span>
              </div>
              {players
                .filter(p => p.id !== myId)
                .map(p => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', fontSize: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', backgroundColor: p.color, border: '1px solid #000' }} />
                      <strong>{p.name}</strong>
                    </div>
                    <span style={{ fontFamily: 'JetBrains Mono', fontWeight: 800, color: p.lives > 0 ? '#00c853' : '#ff3b30' }}>
                      {p.lives > 0 ? `${p.lives} LIVES (${p.progress}%)` : 'ELIMINATED'}
                    </span>
                  </div>
                ))}
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <button className="hero-cta-button" onClick={returnToLobby} style={{ flex: 1 }}>
                ← RETURN TO LOBBY
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= PHASE 5: Results Screen ================= */}
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
              <span>FIELD MANUAL // GUNS & SURVIVAL</span>
              <button
                onClick={() => setShowRules(false)}
                style={{ background: 'none', border: 'none', fontWeight: 900, fontSize: 18 }}
              >
                ✕
              </button>
            </div>

            <h2 style={{ fontSize: '32px', fontWeight: 900, margin: '0 0 10px' }}>
              RUN. SHOOT. <span className="badge-highlight">SURVIVE.</span>
            </h2>
            <p style={{ color: 'var(--muted)', fontSize: '14px', margin: '0 0 24px' }}>
              Sprint 8200m across hostile terrain with other live runners. First 3 across the signal flare claim the podium.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 18, marginBottom: 28 }}>
              <div className="neo-card" style={{ padding: 18 }}>
                <strong style={{ fontSize: 13, textTransform: 'uppercase' }}>1. MOVEMENT & FACING</strong>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6, marginTop: 8 }}>
                  <kbd>A/D</kbd> moves and turns your character's face left/right. Hold <kbd>SHIFT</kbd> to sprint.
                </p>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6 }}>
                  <kbd>SPACE</kbd>/<kbd>W</kbd> jumps over thorns, cacti, and rocks.
                </p>
              </div>

              <div className="neo-card" style={{ padding: 18 }}>
                <strong style={{ fontSize: 13, textTransform: 'uppercase' }}>2. GUN COMBAT</strong>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6, marginTop: 8 }}>
                  Press <kbd>F</kbd> or <kbd>E</kbd> (or tap FIRE) to shoot visible bullets.
                </p>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6 }}>
                  <strong>2 bullet hits</strong> reduce 1 life of the opponent!
                </p>
              </div>

              <div className="neo-card" style={{ padding: 18 }}>
                <strong style={{ fontSize: 13, textTransform: 'uppercase' }}>3. BOXES, BUSHES & THORNS</strong>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6, marginTop: 8 }}>
                  Press <kbd>S</kbd> to hide inside boxes & bushes. Detected within 20m ambush proximity.
                </p>
                <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6 }}>
                  Jump ground thorns; duck or jump over flying birds. 0 lives knocks you out to the lobby.
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
