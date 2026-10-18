import Link from "next/link";
import { signOut } from "../login/actions";

export default function AppLayout({ children }: LayoutProps<"/app">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface px-[5%] py-4">
        <div className="flex flex-wrap items-center gap-6">
          <Link href="/app" className="text-xl font-semibold tracking-tight">
            Shortlist
          </Link>
          <nav className="flex flex-wrap gap-1 text-sm" aria-label="Main">
            <Link href="/app/upload" className="rounded-md px-3 py-2 text-muted hover:text-foreground">Upload CV</Link>
            <Link href="/app/profile" className="rounded-md px-3 py-2 text-muted hover:text-foreground">Profile</Link>
            <Link href="/app/proof" className="rounded-md px-3 py-2 text-muted hover:text-foreground">Proof bank</Link>
          </nav>
        </div>
        <form action={signOut}>
          <button type="submit" className="rounded-lg border border-line px-4 py-2 text-sm">Sign out</button>
        </form>
      </header>
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-10">{children}</main>
    </div>
  );
}
