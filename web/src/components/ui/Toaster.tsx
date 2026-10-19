import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-[var(--app-panel)] group-[.toaster]:text-[var(--app-text)] group-[.toaster]:border-[var(--app-border)] group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-[var(--app-text-muted)]",
          actionButton:
            "group-[.toast]:bg-[var(--app-accent)] group-[.toast]:text-white",
          cancelButton:
            "group-[.toast]:bg-[var(--app-panel-elevated)] group-[.toast]:text-[var(--app-text)]",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
