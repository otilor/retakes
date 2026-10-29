import '../src/App.css'

export const metadata = { title: 'stay' }

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
