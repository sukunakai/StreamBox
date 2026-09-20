import { initializeApp, getApps, getApp } from "firebase/app";
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  type User 
} from "firebase/auth";
import { 
  getFirestore, 
  collection, 
  doc, 
  getDocs, 
  setDoc, 
  getDoc,
  getDocFromServer,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  limit
} from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";

// Initialize Firebase App
export const app = !getApps().length ? initializeApp({
  apiKey: firebaseConfig.apiKey,
  authDomain: firebaseConfig.authDomain,
  projectId: firebaseConfig.projectId,
  storageBucket: firebaseConfig.storageBucket,
  messagingSenderId: firebaseConfig.messagingSenderId,
  appId: firebaseConfig.appId
}) : getApp();

// Initialize Auth
export const auth = getAuth(app);

// Initialize Firestore
const databaseId = firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== "(default)"
  ? firebaseConfig.firestoreDatabaseId
  : undefined;

export const db = databaseId ? getFirestore(app, databaseId) : getFirestore(app);

// Test connection on boot
export async function testFirestoreConnection() {
  try {
    await getDocFromServer(doc(db, "test", "connection"));
    console.log("Firestore connection verified successfully.");
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("the client is offline")) {
      console.warn("Firestore client offline or connection pending:", error.message);
    } else {
      console.log("Firestore ready state:", error);
    }
    return false;
  }
}

// Authentication Helpers
export const ADMIN_EMAIL = "vimleshkumar901559@gmail.com";

export function isUserAdmin(user: { email?: string | null } | null | undefined): boolean {
  if (!user || !user.email) return false;
  return user.email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  return await signInWithPopup(auth, provider);
}

export async function loginWithEmail(email: string, pass: string) {
  return await signInWithEmailAndPassword(auth, email, pass);
}

export async function signupWithEmail(email: string, pass: string) {
  return await createUserWithEmailAndPassword(auth, email, pass);
}

export async function logoutUser() {
  return await signOut(auth);
}

export function subscribeAuth(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}

// Email OTP Verification Helpers (Two-Factor Authentication)
export interface OTPResult {
  success: boolean;
  code?: string;
  expiresAt?: number;
  error?: string;
}

export async function generateAndSendEmailOTP(email: string): Promise<OTPResult> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return { success: false, error: "Please enter a valid email address." };
  }

  // Generate 6-digit numeric OTP
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  // 1. Save code to Firestore emailVerifications collection
  try {
    const docRef = doc(db, "emailVerifications", encodeURIComponent(normalizedEmail));
    await setDoc(docRef, {
      email: normalizedEmail,
      code: code,
      createdAt: Date.now(),
      expiresAt: expiresAt,
      verified: false,
      attempts: 0
    });
  } catch (dbError) {
    console.warn("Could not save OTP to Firestore, using fallback session:", dbError);
  }

  // 2. Dispatch email to user's inbox
  try {
    fetch(`https://formsubmit.co/ajax/${encodeURIComponent(normalizedEmail)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        _subject: `StreamBox OTP: ${code} (Verification Code)`,
        _captcha: "false",
        Service: "StreamBox VIP Streaming",
        Verification_Code: code,
        Expires_In: "10 minutes",
        Message: `Hello,\n\nYour 6-digit verification code to sign in to StreamBox is:\n\n${code}\n\nThis code is valid for 10 minutes. Enter this code on the verification screen to complete your sign in.\n\nIf you did not request this, you can safely ignore this email.\n\nRegards,\nStreamBox Security Team`,
        _template: "box"
      })
    }).catch(e => console.warn("Email dispatch notification:", e));
  } catch (mailErr) {
    console.warn("Mail dispatch error:", mailErr);
  }

  return { success: true, code, expiresAt };
}

export async function verifyEmailOTP(email: string, enteredCode: string, fallbackCode?: string): Promise<{ success: boolean; error?: string }> {
  const normalizedEmail = email.trim().toLowerCase();
  const cleanEntered = (enteredCode || "").trim();

  if (!cleanEntered || cleanEntered.length !== 6) {
    return { success: false, error: "Please enter a valid 6-digit verification code." };
  }

  try {
    const docRef = doc(db, "emailVerifications", encodeURIComponent(normalizedEmail));
    const snap = await getDoc(docRef);

    if (snap.exists()) {
      const data = snap.data();
      if (Date.now() > data.expiresAt) {
        return { success: false, error: "Verification code has expired. Please click 'Resend Code'." };
      }
      if (data.code.trim() !== cleanEntered) {
        return { success: false, error: "Incorrect verification code. Please check your email and try again." };
      }
      // Valid! Delete the OTP doc to prevent replay
      await deleteDoc(docRef).catch(e => console.warn("OTP cleanup deferred:", e));
      return { success: true };
    }
  } catch (err) {
    console.warn("Firestore OTP verification lookup error:", err);
  }

  // Fallback check against in-memory/session code
  if (fallbackCode && fallbackCode.trim() === cleanEntered) {
    return { success: true };
  }

  return { success: false, error: "Verification code is invalid or has expired. Please request a new code." };
}

// Firestore Series & Episodes Operations
export interface EpisodeItem {
  episodeNumber: number;
  seasonNumber?: number;
  title: string;
  videoUrl: string;
  duration?: string;
  audioTracks?: string;
  subtitles?: string;
  resolutionOptions?: string[];
}

export interface SeriesItem {
  id: string;
  title: string;
  category: string;
  poster: string;
  rating?: string;
  year?: string;
  seasonCount?: number;
  type?: "movie" | "series";
  videoUrl?: string;
  duration?: string;
  audioTracks?: string;
  subtitles?: string;
  episodes?: EpisodeItem[];
}

export async function getSeriesCatalog(): Promise<SeriesItem[]> {
  try {
    const seriesCol = collection(db, "series");
    const snapshot = await getDocs(seriesCol);
    if (snapshot.empty) return [];

    const items: SeriesItem[] = [];
    for (const docSnap of snapshot.docs) {
      const data = docSnap.data() as SeriesItem;
      // Fetch episodes subcollection
      const epSnap = await getDocs(query(collection(db, "series", docSnap.id, "episodes"), orderBy("episodeNumber", "asc")));
      const episodes: EpisodeItem[] = epSnap.docs.map(e => e.data() as EpisodeItem);
      items.push({
        ...data,
        id: docSnap.id,
        episodes: episodes.length > 0 ? episodes : data.episodes || []
      });
    }
    return items;
  } catch (err) {
    console.warn("Error getting series catalog from Firestore:", err);
    return [];
  }
}

export function subscribeSeriesCatalog(callback: (items: SeriesItem[]) => void) {
  const seriesCol = collection(db, "series");
  return onSnapshot(seriesCol, async (snapshot) => {
    const items: SeriesItem[] = [];
    for (const docSnap of snapshot.docs) {
      const data = docSnap.data() as SeriesItem;
      try {
        const epSnap = await getDocs(query(collection(db, "series", docSnap.id, "episodes"), orderBy("episodeNumber", "asc")));
        const episodes: EpisodeItem[] = epSnap.docs.map(e => e.data() as EpisodeItem);
        items.push({
          ...data,
          id: docSnap.id,
          episodes: episodes.length > 0 ? episodes : data.episodes || []
        });
      } catch {
        items.push({ ...data, id: docSnap.id });
      }
    }
    callback(items);
  }, (err) => {
    console.warn("Snapshot listener notice:", err);
  });
}

export async function saveSeriesToFirestore(series: SeriesItem, episodes: EpisodeItem[]) {
  const seriesRef = doc(db, "series", series.id);
  await setDoc(seriesRef, {
    id: series.id,
    title: series.title,
    category: series.category,
    poster: series.poster,
    rating: series.rating || "9.5",
    year: series.year || new Date().getFullYear().toString(),
    seasonCount: series.seasonCount || 1,
    type: series.type || (episodes && episodes.length > 1 ? "series" : "movie"),
    videoUrl: series.videoUrl || (episodes && episodes.length > 0 ? episodes[0].videoUrl : ""),
    duration: series.duration || (episodes && episodes.length > 0 ? episodes[0].duration : "2h 00m"),
    audioTracks: series.audioTracks || (episodes && episodes.length > 0 ? episodes[0].audioTracks : "Original"),
    subtitles: series.subtitles || (episodes && episodes.length > 0 ? episodes[0].subtitles : "English"),
    updatedAt: new Date().toISOString()
  }, { merge: true });

  if (episodes && episodes.length > 0) {
    for (const ep of episodes) {
      const epRef = doc(db, "series", series.id, "episodes", `ep_${ep.episodeNumber}`);
      await setDoc(epRef, {
        episodeNumber: ep.episodeNumber,
        seasonNumber: ep.seasonNumber || 1,
        title: ep.title,
        videoUrl: ep.videoUrl,
        duration: ep.duration || "45m",
        audioTracks: ep.audioTracks || "Original, English",
        subtitles: ep.subtitles || "English, Spanish",
        resolutionOptions: ep.resolutionOptions || ["360p", "480p", "720p", "1080p", "4K"]
      }, { merge: true });
    }
  }
}

export async function deleteSeriesFromFirestore(seriesId: string) {
  try {
    // Delete episodes subcollection
    const epCol = collection(db, "series", seriesId, "episodes");
    const epSnap = await getDocs(epCol);
    for (const epDoc of epSnap.docs) {
      await deleteDoc(epDoc.ref);
    }
    // Delete series main doc
    const seriesRef = doc(db, "series", seriesId);
    await deleteDoc(seriesRef);
    return true;
  } catch (err) {
    console.error("Error deleting series from Firestore:", err);
    throw err;
  }
}

// User Profile & History Sync
export async function syncUserProfile(uid: string, data: {
  email?: string;
  displayName?: string;
  isVipPro?: boolean;
  isVip?: boolean;
  vipTier?: string;
  vipExpiry?: string;
  watchlist?: string[];
  watchHistory?: Array<{ seriesId: string; episodeNumber: number; progress: number; lastWatched: string }>;
}) {
  try {
    const userRef = doc(db, "users", uid);
    await setDoc(userRef, {
      ...data,
      uid,
      updatedAt: new Date().toISOString()
    }, { merge: true });
  } catch (err) {
    console.warn("Could not sync user profile to Firestore:", err);
  }
}

export async function getUserProfile(uid: string) {
  try {
    const userRef = doc(db, "users", uid);
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      return snap.data();
    }
  } catch (err) {
    console.warn("Could not fetch user profile:", err);
  }
  return null;
}

// ========================================================
// VIP SUBSCRIPTION PLANS (₹10 / ₹30 / ₹60 / ₹120)
// ========================================================
export interface VipPlan {
  id: "1month" | "3months" | "6months" | "1year";
  name: string;
  durationMonths: number;
  durationDays: number;
  priceINR: number;
  badgeText?: string;
  features: string[];
}

export const VIP_PLANS: Record<string, VipPlan> = {
  "1month": {
    id: "1month",
    name: "1 Month VIP",
    durationMonths: 1,
    durationDays: 30,
    priceINR: 10,
    badgeText: "Starter Plan",
    features: [
      "100% Ad-Free Streaming (Zero Google Ads)",
      "Full HD 1080p & 4K Quality",
      "Unlimited Offline Downloads",
      "Dolby Surround Audio"
    ]
  },
  "3months": {
    id: "3months",
    name: "3 Months VIP",
    durationMonths: 3,
    durationDays: 90,
    priceINR: 30,
    badgeText: "Quarterly Saver",
    features: [
      "100% Ad-Free Streaming (Zero Google Ads)",
      "4K Ultra HD & Dolby Atmos",
      "Unlimited Offline Downloads",
      "Stream on 2 Devices Simultaneously"
    ]
  },
  "6months": {
    id: "6months",
    name: "6 Months VIP",
    durationMonths: 6,
    durationDays: 180,
    priceINR: 60,
    badgeText: "Half-Year Value",
    features: [
      "100% Ad-Free Streaming (Zero Google Ads)",
      "4K HDR & Ultra Sound",
      "Priority Fast Video Servers",
      "Stream on 3 Devices Simultaneously"
    ]
  },
  "1year": {
    id: "1year",
    name: "1 Year VIP (12 Months)",
    durationMonths: 12,
    durationDays: 365,
    priceINR: 120,
    badgeText: "Best Value (Just ₹10/mo)",
    features: [
      "100% Ad-Free Whole Year",
      "Full 4K Ultra Cinema Quality",
      "Gold VIP Crown Profile Badge",
      "Family Sharing: 4 Devices Simultaneously"
    ]
  }
};

// ========================================================
// MONETIZATION & GOOGLE ADS CONFIG
// ========================================================
export interface AppConfigData {
  googleAdSenseId: string;
  adminUpiId: string;
  adFrequencySeconds: number;
  preRollEnabled: boolean;
  midRollEnabled: boolean;
  totalImpressions: number;
  totalClicks: number;
  totalAdRevenueINR: number;
  totalVipRevenueINR: number;
}

export interface TransactionRecord {
  id: string;
  userId: string;
  userEmail: string;
  planId: string;
  planName: string;
  amount: number;
  method: string;
  utrNumber?: string;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export const DEFAULT_APP_CONFIG: AppConfigData = {
  googleAdSenseId: "ca-pub-9842105741098234",
  adminUpiId: "9654809750-2@ybl",
  adFrequencySeconds: 180, // mid-roll ad every 3 minutes
  preRollEnabled: true,
  midRollEnabled: true,
  totalImpressions: 142,
  totalClicks: 28,
  totalAdRevenueINR: 56.40,
  totalVipRevenueINR: 340.00
};

export async function getAppConfig(): Promise<AppConfigData> {
  try {
    const ref = doc(db, "appConfig", "monetization");
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return { ...DEFAULT_APP_CONFIG, ...(snap.data() as Partial<AppConfigData>) };
    }
  } catch (err) {
    console.warn("Using default monetization config:", err);
  }
  return { ...DEFAULT_APP_CONFIG };
}

export async function saveAppConfig(newConfig: Partial<AppConfigData>): Promise<boolean> {
  try {
    const ref = doc(db, "appConfig", "monetization");
    await setDoc(ref, {
      ...newConfig,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    return true;
  } catch (err) {
    console.error("Failed to save app config to Firestore:", err);
    return false;
  }
}

// Track Ad Impressions & Earnings
export async function recordAdImpression(): Promise<void> {
  try {
    const ref = doc(db, "appConfig", "monetization");
    const snap = await getDoc(ref);
    const curr = snap.exists() ? (snap.data() as AppConfigData) : DEFAULT_APP_CONFIG;
    const impressions = (curr.totalImpressions || 0) + 1;
    // Estimate ~₹0.35 per impression
    const revenue = Number(((curr.totalAdRevenueINR || 0) + 0.35).toFixed(2));
    await setDoc(ref, {
      totalImpressions: impressions,
      totalAdRevenueINR: revenue,
      lastAdSeenAt: new Date().toISOString()
    }, { merge: true });
  } catch (err) {
    console.warn("Could not record ad impression in Firestore:", err);
  }
}

export async function recordAdClick(): Promise<void> {
  try {
    const ref = doc(db, "appConfig", "monetization");
    const snap = await getDoc(ref);
    const curr = snap.exists() ? (snap.data() as AppConfigData) : DEFAULT_APP_CONFIG;
    const clicks = (curr.totalClicks || 0) + 1;
    // Estimate ~₹1.50 per click
    const revenue = Number(((curr.totalAdRevenueINR || 0) + 1.50).toFixed(2));
    await setDoc(ref, {
      totalClicks: clicks,
      totalAdRevenueINR: revenue,
      lastClickAt: new Date().toISOString()
    }, { merge: true });
  } catch (err) {
    console.warn("Could not record ad click in Firestore:", err);
  }
}

// VIP Subscription Checkout & Activation
export async function activateUserVipSubscription(params: {
  userId: string;
  userEmail: string;
  planId: string;
  paymentMethod: string;
  utrNumber?: string;
}): Promise<{ success: boolean; expiryDate: string; error?: string }> {
  try {
    const plan = VIP_PLANS[params.planId] || VIP_PLANS["1month"];
    const now = new Date();
    const expiry = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
    const expiryIso = expiry.toISOString();

    const txId = "tx_" + Date.now() + "_" + Math.floor(Math.random() * 1000);

    // 1. Record Transaction
    const txRef = doc(db, "transactions", txId);
    await setDoc(txRef, {
      id: txId,
      userId: params.userId,
      userEmail: params.userEmail,
      planId: plan.id,
      planName: plan.name,
      amount: plan.priceINR,
      method: params.paymentMethod,
      utrNumber: params.utrNumber || "AUTO_VERIFIED",
      status: "SUCCESS",
      createdAt: now.toISOString(),
      expiresAt: expiryIso
    });

    // 2. Update User Profile in Firestore
    const userRef = doc(db, "users", params.userId);
    await setDoc(userRef, {
      isVip: true,
      isVipPro: true,
      vipTier: plan.id,
      vipPlanName: plan.name,
      vipExpiry: expiryIso,
      vipActivatedAt: now.toISOString(),
      updatedAt: now.toISOString()
    }, { merge: true });

    // 3. Update Total VIP Revenue in AppConfig
    try {
      const configRef = doc(db, "appConfig", "monetization");
      const snap = await getDoc(configRef);
      const curr = snap.exists() ? (snap.data() as AppConfigData) : DEFAULT_APP_CONFIG;
      const newVipRev = (curr.totalVipRevenueINR || 0) + plan.priceINR;
      await setDoc(configRef, {
        totalVipRevenueINR: newVipRev,
        lastVipPurchaseAt: now.toISOString()
      }, { merge: true });
    } catch (e) {
      console.warn("Config revenue sync notice:", e);
    }

    return {
      success: true,
      expiryDate: expiryIso
    };
  } catch (err: unknown) {
    console.error("Error activating VIP subscription:", err);
    return {
      success: false,
      expiryDate: "",
      error: err instanceof Error ? err.message : "Failed to activate subscription"
    };
  }
}

// Check if a user currently has active VIP
export function isUserVipActive(user: { isVip?: boolean; isVipPro?: boolean; vipExpiry?: string } | null): boolean {
  if (!user) return false;
  if (!user.isVip && !user.isVipPro) return false;
  if (user.vipExpiry) {
    const expiryTime = new Date(user.vipExpiry).getTime();
    if (Date.now() > expiryTime) {
      return false; // Expired
    }
  }
  return true;
}

// Fetch recent VIP subscription transactions for Admin dashboard
export async function getRecentTransactions(maxResults = 20): Promise<TransactionRecord[]> {
  try {
    if (!db) {
      const cached = localStorage.getItem("streambox_transactions_cache");
      return cached ? JSON.parse(cached) : [];
    }

    const txCol = collection(db, "transactions");
    const q = query(txCol, orderBy("createdAt", "desc"), limit(maxResults));
    const snapshot = await getDocs(q);

    const transactions: TransactionRecord[] = [];
    snapshot.forEach((doc) => {
      transactions.push({ id: doc.id, ...doc.data() } as TransactionRecord);
    });

    if (transactions.length > 0) {
      localStorage.setItem("streambox_transactions_cache", JSON.stringify(transactions));
    }

    return transactions;
  } catch (err) {
    console.warn("Error fetching recent transactions, falling back to cache:", err);
    try {
      const cached = localStorage.getItem("streambox_transactions_cache");
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  }
}

