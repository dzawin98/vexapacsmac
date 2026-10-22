interface Window {
  google?: {
    accounts: {
      id: {
        initialize: (config: {
          client_id: string;
          callback: (response: { credential: string }) => void;
          auto_select?: boolean;
          cancel_on_tap_outside?: boolean;
        }) => void;
        renderButton: (
          element: HTMLElement,
          options: {
            theme?: "outline" | "filled_blue" | "filled_black";
            size?: "large" | "medium" | "small";
            text?: "signin_with" | "signup_with" | "continue_with" | "signin";
            shape?: "rectangular" | "pill" | "circle" | "square";
            logo_alignment?: "left" | "center";
            width?: string;
            locale?: string;
          }
        ) => void;
        prompt: (
          momentListener?: (notification: { isNotDisplayed: () => boolean; isSkippedMoment: () => boolean; getDismissedReason: () => string; getNotDisplayedReason: () => string; getSkippedReason: () => string }) => void
        ) => void;
      };
    };
  };
}
