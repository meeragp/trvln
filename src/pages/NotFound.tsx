import { useLocation } from "react-router-dom";
import { useEffect } from "react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="text-center">
        <h1 className="mb-3 font-display text-6xl leading-none md:text-7xl">Off the map</h1>
        <p className="mb-6 text-lg text-muted-foreground">There's no page here.</p>
        <a href="/" className="inline-flex min-h-11 items-center text-base underline underline-offset-4 hover:text-primary">
          Back to planning a trip
        </a>
      </div>
    </div>
  );
};

export default NotFound;
