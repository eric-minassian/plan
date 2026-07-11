import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@eric-minassian/design/components/alert";
import { CircleAlertIcon } from "lucide-react";

export function ErrorAlert(props: {
  readonly title?: string;
  readonly children: string;
}) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      {props.title !== undefined ? (
        <AlertTitle>{props.title}</AlertTitle>
      ) : null}
      <AlertDescription>{props.children}</AlertDescription>
    </Alert>
  );
}
