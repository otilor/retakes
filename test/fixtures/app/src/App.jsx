import './App.css'
import SearchBar from './SearchBar.jsx'
import Filters from './Filters.jsx'
import Listing from './Listing.jsx'

const listings = Array.from({ length: 40 }, (_, i) => i + 1)

export default function App() {
  return (
    <>
      <header className="top">
        <strong className="logo">stay</strong>
        <SearchBar />
      </header>
      <main>
        <p className="greeting">{import.meta.env.VITE_GREETING || "no env"}</p>
        <Filters />
        <div className="grid">
          {listings.map((n) => (
            <Listing key={n} n={n} />
          ))}
        </div>
      </main>
    </>
  )
}
