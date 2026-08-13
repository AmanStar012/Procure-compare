import * as React from "react"
import { Link } from "wouter"
import { FileSpreadsheet } from "lucide-react"

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="border-b bg-card sticky top-0 z-30">
        <div className="container mx-auto px-4 h-14 flex items-center">
          <Link href="/" className="flex items-center gap-2 font-medium text-primary tracking-tight transition-colors hover:text-primary/80">
            <FileSpreadsheet className="w-5 h-5" />
            <span>ProcureCompare</span>
          </Link>
        </div>
      </header>
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 py-8">
        {children}
      </main>
    </div>
  )
}
