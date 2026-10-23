import { useCallback, useEffect, useId, useRef, type JSX } from 'react'

const CONVERSION_ARROW = 'M824 207H949C1008 207 1040 232 1040 275C1040 315 1004 347 960 379L898 426C883 437 877 442 877 447C877 453 886 455 904 455H1133V424C1133 420 1135 419 1138 421L1219 470C1223 472 1223 474 1219 476L1138 525C1135 527 1133 526 1133 522V492H904C851 492 824 480 824 456C824 435 843 417 869 397L954 333C978 315 993 294 993 276C993 251 972 238 936 238H805C801 238 800 236 803 232L819 210C820 208 822 207 824 207Z'
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** Outlines from svg/web2term-transparent.svg, with colors inherited from the workspace theme. */
export default function Web2termWordmark(): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const animationsRef = useRef<Animation[]>([])
  const arrowClipId = `web2term-arrow-${useId()}`

  const stopAnimation = useCallback(() => {
    animationsRef.current.forEach(animation => animation.cancel())
    animationsRef.current = []
  }, [])

  const playAnimation = useCallback(() => {
    const svg = svgRef.current
    if (!svg || document.hidden || window.matchMedia(REDUCED_MOTION_QUERY).matches) return

    const trace = svg.querySelector<SVGPathElement>('[data-motion="signal"]')
    if (!trace) return
    stopAnimation()
    const length = trace.getTotalLength()
    const dash = 100
    trace.style.strokeDasharray = `${dash} ${length + dash * 2}`

    const animations: Animation[] = []
    const animate = (part: string, frames: Keyframe[], duration: number, delay = 0, easing = 'linear'): void => {
      const element = svg.querySelector<SVGElement>(`[data-motion="${part}"]`)
      if (!element) return
      animations.push(element.animate(frames, { duration, delay, easing, iterations: 1, fill: 'none' }))
    }

    animate('dot-left', [{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }], 240)
    animate('dot-right', [{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }], 240, 90)
    animate('signal', [
      { strokeDashoffset: String(dash), opacity: 0, offset: 0 },
      { strokeDashoffset: '0', opacity: 1, offset: 0.1 },
      { strokeDashoffset: String(-length + dash), opacity: 1, offset: 0.9 },
      { strokeDashoffset: String(-length - dash), opacity: 0, offset: 1 }
    ], 820, 180, 'cubic-bezier(0.2, 0, 0.38, 0.9)')
    animate('prompt', [{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }], 240, 900)
    animate('cursor', [
      { opacity: 1, offset: 0 },
      { opacity: 0.12, offset: 0.14 },
      { opacity: 0.12, offset: 0.3 },
      { opacity: 1, offset: 0.32 },
      { opacity: 1, offset: 0.54 },
      { opacity: 0.12, offset: 0.56 },
      { opacity: 0.12, offset: 0.74 },
      { opacity: 1, offset: 0.76 },
      { opacity: 1, offset: 1 }
    ], 450, 1000)

    animationsRef.current = animations
    void Promise.all(animations.map(animation => animation.finished)).then(() => {
      if (animationsRef.current === animations) animationsRef.current = []
    }).catch(() => {})
  }, [stopAnimation])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    let visible = false
    let entrancePlayed = false
    const playEntrance = (): void => {
      if (entrancePlayed || !visible || document.hidden) return
      entrancePlayed = true
      observer.disconnect()
      playAnimation()
    }
    // Wait for a collapsed sidebar to reveal the wordmark before playing its entrance.
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting)
      playEntrance()
    })
    const motionPreference = window.matchMedia(REDUCED_MOTION_QUERY)
    const handleMotionPreference = (): void => {
      if (motionPreference.matches) stopAnimation()
    }
    observer.observe(svg)
    document.addEventListener('visibilitychange', playEntrance)
    motionPreference.addEventListener('change', handleMotionPreference)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', playEntrance)
      motionPreference.removeEventListener('change', handleMotionPreference)
      stopAnimation()
    }
  }, [playAnimation, stopAnimation])

  return <svg ref={svgRef} viewBox="153 183 1833 369" role="img" aria-label="web2term" focusable="false" onPointerEnter={playAnimation}>
    <defs>
      <clipPath id={arrowClipId} clipPathUnits="userSpaceOnUse"><path d={CONVERSION_ARROW} /></clipPath>
    </defs>
    <g fill="currentColor">
      <path d="M240 210H792C790 221 782 229 773 229H241C216 229 196 249 196 274V336C196 361 203 382 211 402L226 436C229 444 234 444 238 436L267 379C274 365 283 358 297 358C311 358 319 365 327 381L353 435C357 444 364 445 368 434L407 330H449L401 457C391 484 381 494 361 494C342 494 332 486 322 468L297 414L268 469C258 487 248 494 231 494C212 494 200 484 189 458C181 439 177 424 177 407V274C177 239 205 210 240 210Z" />
      <ellipse data-motion="dot-left" cx="241" cy="259.5" rx="14" ry="13.5" />
      <ellipse data-motion="dot-right" cx="290" cy="259.5" rx="14" ry="13.5" />
      <path fillRule="evenodd" d="M524 328H542C590 328 616 354 616 405V425H485C488 445 499 455 518 455H604V493H513C466 493 441 465 441 412V408C441 356 470 328 524 328ZM485 393H573C570 374 558 365 537 365H521C502 365 490 374 485 393Z" />
      <path fillRule="evenodd" d="M629 269H670V335C681 330 694 328 710 328H724C775 328 803 357 803 409V416C803 466 776 494 725 494H711C659 494 629 469 629 420ZM702 365C680 365 670 377 670 400V420C670 443 680 455 702 455H727C749 455 760 442 760 420V401C760 377 749 365 727 365Z" />
    </g>
    <path fill="var(--web2term-accent, #4d3efd)" d={CONVERSION_ARROW} />
    <path className="web2term-wordmark__signal" data-motion="signal" clipPath={`url(#${arrowClipId})`} fill="none" strokeWidth="24" strokeLinecap="round" d="M810 223H944C990 223 1016 242 1016 276C1016 307 985 335 957 357L882 414C853 436 846 450 864 465C875 474 891 474 917 474H1218" />
    <g fill="currentColor">
      <path d="M1206 257H1284C1293 257 1298 262 1300 273H1207C1187 273 1173 289 1173 310V421L1157 412V310C1157 280 1178 257 1206 257Z" />
      <g data-motion="prompt">
        <path fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" d="M1209 302L1234 321.5L1209 341" />
        <rect x="1244" y="348" width="42" height="9" rx="3.5" />
      </g>
      <path d="M1338 297H1376V328H1424V365H1376V430C1376 445 1384 452 1401 452H1424V490H1397C1357 490 1338 472 1338 432V365H1316V328H1338Z" />
      <path fillRule="evenodd" d="M1489 328H1526C1562 328 1581 351 1581 391V424H1471V431C1471 445 1478 452 1492 452H1571V490H1490C1451 490 1432 465 1432 420V400C1432 351 1452 328 1489 328ZM1471 390H1543V383C1543 370 1534 364 1517 364H1497C1480 364 1471 372 1471 385Z" />
      <path d="M1593 490V391C1593 348 1612 328 1651 328H1695V367H1655C1639 367 1632 374 1632 391V490Z" />
      <path d="M1700 490V391C1700 350 1721 328 1754 328C1772 328 1785 333 1796 342C1807 333 1821 328 1838 328C1877 328 1895 350 1895 391V490H1856V386C1856 373 1850 367 1837 367H1828C1815 367 1809 373 1809 386V490H1775V386C1775 373 1769 367 1756 367H1749C1741 367 1739 373 1739 386V490Z" />
      <path d="M1247.5 415C1251.5 415 1255 418.5 1255 423V479C1255 500 1265 513 1287 513H1895V528H1287C1256 528 1240 510 1240 479V423C1240 418.5 1243.5 415 1247.5 415Z" />
      <path data-motion="cursor" d="M1913 451H1962V527H1913Z" />
    </g>
  </svg>
}
