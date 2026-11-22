import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from './AuthProvider';
import { useEntitlements } from './EntitlementsProvider';
import { AuthModal } from './AuthModal';
import { LogOut, User, Ticket } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function UserMenu() {
  const { user, signOut, loading } = useAuth();
  const { hasPurchased, balance } = useEntitlements();
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const name: string = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || '';
  const initial = name.trim().charAt(0).toUpperCase();

  if (loading) {
    return (
      <div className="w-8 h-8 rounded-full bg-muted animate-pulse" />
    );
  }

  if (!user) {
    return (
      <>
        <Button 
          variant="outline" 
          size="sm"
          onClick={() => setAuthModalOpen(true)}
        >
          Sign In
        </Button>
        <AuthModal open={authModalOpen} onOpenChange={setAuthModalOpen} />
      </>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-11 w-11 rounded-full" aria-label="Account">
          {/* An ink disc with their initial, like the selected options */}
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-foreground font-display text-lg leading-none text-background">
            {initial || <User className="h-4 w-4" />}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-1.5 text-sm text-muted-foreground truncate">
          {user.email}
        </div>
        {hasPurchased && (
          <div className="px-2 py-1.5 text-sm flex items-center gap-2 text-foreground">
            <Ticket className="w-4 h-4 text-foreground" />
            {balance === 1 ? '1 trip left' : `${balance} trips left`}
          </div>
        )}
        <DropdownMenuItem onClick={signOut} className="text-destructive cursor-pointer">
          <LogOut className="w-4 h-4 mr-2" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
