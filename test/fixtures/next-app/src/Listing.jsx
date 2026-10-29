export default function Listing({ n }) {
  return (
    <article className="listing" data-n={n}>
      <div className="listing-img" style={{ background: `hsl(${(n * 47) % 360} 55% 75%)` }} />
      <h3>Canal loft {n}</h3>
      <p>Entire home · {2 + (n % 4)} guests</p>
    </article>
  )
}
