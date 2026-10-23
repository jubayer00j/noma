import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      // Edge-to-edge (native-feel #2) draws the app under the gesture
      // bar, and sonner has no safe-area awareness: its default bottom
      // offsets (24px desktop / 16px mobile) can leave a toast — and its
      // Undo action — under the gesture bar. Keep the defaults as the
      // floor, but never less than the bottom inset. Object form: every
      // other side keeps sonner's default.
      offset={{ bottom: "max(24px, env(safe-area-inset-bottom, 0px))" }}
      mobileOffset={{ bottom: "max(16px, env(safe-area-inset-bottom, 0px))" }}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
