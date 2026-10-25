import { ArrowLeft, Mail, MessageSquare, Send } from "lucide-react";
import { Link } from "@tanstack/react-router";

// Developer Photo component using exact supplied photo in public/dev-jubayer.png
export function ContactSection() {
  const contactMethods = [
    {
      label: "Contact via Email",
      platform: "Email",
      icon: Mail,
      color:
        "bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 border-blue-500/20",
      href: "mailto:dev.jubayer00j@gmail.com",
    },
    {
      label: "Message on Messenger",
      platform: "Messenger",
      icon: MessageSquare,
      color:
        "bg-purple-500/10 text-purple-600 dark:text-purple-400 hover:bg-purple-500/20 border-purple-500/20",
      href: "https://m.me/jubayer00j",
    },
    {
      label: "Chat on Telegram",
      platform: "Telegram",
      icon: Send,
      color: "bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20 border-sky-500/20",
      href: "https://t.me/jubayer00j",
    },
    {
      label: "Chat on WhatsApp",
      platform: "WhatsApp",
      icon: () => (
        <svg aria-hidden="true" className="size-5 fill-current" viewBox="0 0 24 24">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.572-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c-.001 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
        </svg>
      ),
      color:
        "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 border-emerald-500/20",
      href: "https://wa.me/+8801610017288",
    },
  ];

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-14 items-center gap-3 border-b border-border px-4 sm:px-6">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to Notes
        </Link>
      </header>

      <main className="noma-scroll flex-1 overflow-y-auto px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-xl space-y-8 text-center">
          <div className="space-y-4">
            <div className="mx-auto size-24 overflow-hidden rounded-full border-2 border-border shadow-md">
              <img
                src="/dev-jubayer.png"
                alt="Developer photo"
                className="size-full object-cover"
                width={96}
                height={96}
              />
            </div>

            <div className="space-y-1.5">
              <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground">
                Hi, I'm Jubayer 👋
              </h1>
              <p className="text-sm font-medium text-primary">Creator & Developer of Noma</p>
            </div>

            <p className="mx-auto max-w-md text-sm text-muted-foreground leading-relaxed">
              Found a bug, have a feature request, need help, or just want to share some feedback?
              I'd love to hear from you. Your feedback helps make Noma better for everyone.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
            {contactMethods.map((method) => {
              const Icon = method.icon;
              return (
                <a
                  key={method.platform}
                  href={method.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex items-center justify-center gap-3 rounded-lg border px-4 py-3.5 text-sm font-medium transition-colors ${method.color}`}
                >
                  <Icon />
                  <span>{method.label}</span>
                </a>
              );
            })}
          </div>

          <div className="border-t border-border/60 pt-6">
            <p className="text-xs text-muted-foreground">
              Noma v1.2.0 • Calm, offline-first notes for Web, PWA, and Android.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
