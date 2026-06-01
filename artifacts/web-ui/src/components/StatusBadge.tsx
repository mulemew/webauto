import { Badge } from "@/components/ui/badge";
  import { CheckCircle2, XCircle, Clock, Loader2, AlertTriangle, Timer } from "lucide-react";

  export function StatusBadge({ status }: { status: string }) {
    switch (status) {
      case "success":
        return <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20 font-mono text-xs">SUCCESS</Badge>;
      case "failed":
        return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20 font-mono text-xs">FAILED</Badge>;
      case "running":
        return <Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-500/20 font-mono text-xs animate-pulse">RUNNING</Badge>;
      case "queued":
        return <Badge variant="outline" className="bg-purple-500/10 text-purple-600 border-purple-500/20 font-mono text-xs">QUEUED</Badge>;
      case "needs_attention":
        return <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/30 font-mono text-xs">NEEDS ATTENTION</Badge>;
      default:
        return <Badge variant="outline" className="bg-muted text-muted-foreground border-border font-mono text-xs">{status.toUpperCase()}</Badge>;
    }
  }

  export function StatusIcon({ status }: { status: string }) {
    switch (status) {
      case "success": return <CheckCircle2 className="h-5 w-5 text-green-500" />;
      case "failed": return <XCircle className="h-5 w-5 text-destructive" />;
      case "running": return <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />;
      case "queued": return <Timer className="h-5 w-5 text-purple-500" />;
      case "needs_attention": return <AlertTriangle className="h-5 w-5 text-amber-500" />;
      default: return <Clock className="h-5 w-5 text-muted-foreground" />;
    }
  }
  