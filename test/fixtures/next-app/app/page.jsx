import SearchBar from '../src/SearchBar.jsx'
import Filters from '../src/Filters.jsx'
import Listing from '../src/Listing.jsx'

const listings = Array.from({ length: 40 }, (_, i) => i + 1)

export default function Home() {
  return (
    <>
      <header className="top">
        <strong className="logo">stay</strong>
        <SearchBar />
      </header>
      <main>
        <p className="greeting">{process.env.NEXT_PUBLIC_GREETING || 'no env'}</p>
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
