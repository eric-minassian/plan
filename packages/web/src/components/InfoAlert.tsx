import {
  Alert,
  AlertDescription,
} from "@eric-minassian/design/components/alert";
import { InfoIcon } from "lucide-react";

export function InfoAlert(props: { readonly children: string }) {
  return (
    <Alert>
      <InfoIcon />
      <AlertDescription>{props.children}</AlertDescription>
    </Alert>
  );
}
