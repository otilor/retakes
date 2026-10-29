'use client'

export default function SearchBar() {
  return (
    <form className="search" role="search" onSubmit={(e) => e.preventDefault()}>
      <input className="search-input" placeholder="Where to?" aria-label="Where to?" />
      <button className="search-button" type="submit">Search</button>
    </form>
  )
}
