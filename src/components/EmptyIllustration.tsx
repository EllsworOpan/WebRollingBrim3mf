export default function EmptyIllustration() {
  return <svg className="empty-diagram" viewBox="0 0 320 170" role="img" aria-label="Diagram of a circle defining a brim around a model footprint">
    <defs><pattern id="empty-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#29363e" strokeWidth=".6" /></pattern></defs>
    <rect x="5" y="5" width="310" height="160" rx="14" fill="url(#empty-grid)" />
    <path d="M104 49H191V80H222V116H179V105H104Z" fill="#91a7ae18" stroke="#95afb7" strokeWidth="1.4" />
    <path d="M104 33H191Q207 33 207 49V64H222Q238 64 238 80V116Q238 132 222 132H179Q164 132 163 121H104Q88 121 88 105V49Q88 33 104 33Z" fill="none" stroke="#ffb454" strokeWidth="1.6" />
    <path d="M104 38H191Q202 38 202 49V69H222Q233 69 233 80V116Q233 127 222 127H179Q166 127 167 116H104Q93 116 93 105V49Q93 38 104 38Z" fill="none" stroke="#ffb454" strokeOpacity=".5" strokeWidth="1" />
    <circle cx="80" cy="66" r="24" fill="#ffb4540d" stroke="#ffb454" strokeWidth="1.5" strokeDasharray="4 3" /><circle cx="80" cy="66" r="2" fill="#ffb454" />
    <path d="M78 35Q69 22 51 27" fill="none" stroke="#73868d" strokeWidth="1" /><text x="21" y="25" fill="#a1b0b5" fontSize="10" fontFamily="monospace">ROLLING Ø</text>
    <text x="243" y="146" fill="#7e9199" fontSize="9" fontFamily="monospace">XY / 01</text>
  </svg>;
}
