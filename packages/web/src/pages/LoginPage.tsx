import { Button } from "@eric-minassian/design/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@eric-minassian/design/components/card";
import { useAuth } from "@ericminassian/auth/react";

/** Unauthenticated landing — CTA to start PKCE login at auth.ericminassian.com. */
export function LoginPage() {
  const { signIn } = useAuth();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Welcome to TripPlan</CardTitle>
        <CardDescription>
          Sign in with your passkey to list and create trips.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          onClick={() => {
            void signIn({ returnTo: "/" });
          }}
        >
          Sign in
        </Button>
      </CardContent>
    </Card>
  );
}
