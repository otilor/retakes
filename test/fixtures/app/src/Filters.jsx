import { useState } from 'react'

export default function Filters() {
  const [filters, setFilters] = useState(['Entire home', 'Wifi'])
  return (
    <div className="filters">
      {filters.map((f) => (
        <span className="chip" key={f}>{f}</span>
      ))}
      {filters.length === 0 && <span className="none">No filters</span>}
      <button className="clear" onClick={() => setFilters([])}>Clear filters</button>
    </div>
  )
}
