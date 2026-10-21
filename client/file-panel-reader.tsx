import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { docLocateRpc } from "../shared/rpc";
import { DocumentScreen } from "./document-screen";
import type { FilePanelProps } from "./file-panel";
import { readerLayout } from "./panel-layout";
import { ErrorState, LoadingState, makeStyles } from "./ui";

// The reader in Paseo's file tab, which already names the file, so it adds no header. The daemon finds
// the workspace path the reader reads by.
export function FilePanelReader({ file, workspaceId, host, theme, layout }: FilePanelProps) {
  const [width, setWidth] = useState(0);
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const locate = useRpc(docLocateRpc);
  const located = useQuery({
    queryKey: ["doc.locate", workspaceId, file.path],
    queryFn: () => locate({ workspaceId, absolutePath: file.path }),
    retry: false,
    staleTime: Infinity,
  });
  return (
    <View style={styles.screen} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {located.data ? (
        <DocumentScreen host={host} theme={theme} layout={readerLayout(layout, width)} phone={layout.compact} chooser={false}
          params={{ workspaceId, path: located.data.path }} />
      ) : located.error ? (
        <ErrorState theme={theme} styles={styles} error={located.error} onRetry={() => void located.refetch()} />
      ) : (
        <LoadingState theme={theme} styles={styles} />
      )}
    </View>
  );
}
