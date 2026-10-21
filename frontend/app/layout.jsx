import "./globals.css";

export const metadata = { title: "YT Clipper", description: "Potong bagian tertentu dari video YouTube, preview, lalu unduh." };

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
