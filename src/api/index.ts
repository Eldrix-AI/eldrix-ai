import express, { Request, Response } from "express";
import { app } from "../server";

// Export the dynamic directive for Next.js
export const dynamic = "force-dynamic";

// This exports the app for Vercel to use
export default app;
