import React, { useState, useEffect, useRef } from "react";
import { 
  Camera, 
  Search, 
  LogOut, 
  Download, 
  FolderOpen, 
  CheckCircle2, 
  AlertCircle,
  Loader2,
  RefreshCcw,
  ChevronRight,
  Image as ImageIcon
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface DriveFile {
  id: string;
  name: string;
  thumbnailLink?: string;
  webContentLink?: string;
}

export default function App() {
  const [authStatus, setAuthStatus] = useState<{ authenticated: boolean }>({ authenticated: false });
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  
  const [step, setStep] = useState(1);
  const [folderLink, setFolderLink] = useState("");
  const [folders, setFolders] = useState<DriveFile[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<DriveFile | null>(null);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isValidatingLink, setIsValidatingLink] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [matches, setMatches] = useState<DriveFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    checkAuth();
    
    const handleMessage = (event: MessageEvent) => {
      console.log("Message received from popup:", event.data);
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        // Wait a bit for cookies to settle
        setTimeout(() => {
          checkAuth();
        }, 1000);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const [isRefreshingAuth, setIsRefreshingAuth] = useState(false);

  const checkAuth = async () => {
    try {
      setIsRefreshingAuth(true);
      setError(null);
      console.log("Fetching auth status...");
      const res = await fetch('/api/auth/status', { credentials: 'include' });
      const data = await res.json();
      console.log("Auth status data:", data);
      
      setAuthStatus(data);
      if (data.authenticated) {
        loadFolders();
      } else {
        if (data.reason === "No session data") {
          console.warn("Session data not found. Browsers often block cookies in iframes.");
        }
      }
    } catch (err) {
      console.error("Auth check failed", err);
      setError("Connection failed. Please check if your browser blocks cookies.");
    } finally {
      setIsLoadingStatus(false);
      setIsRefreshingAuth(false);
    }
  };

  const loadFolders = async () => {
    try {
      const res = await fetch('/api/drive/folders', { credentials: 'include' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setFolders(data);
    } catch (err: any) {
      setError(err.message || "Failed to load Google Drive folders");
    }
  };

  const handleAddLink = async () => {
    setError(null);
    const folderId = extractFolderId(folderLink);
    if (!folderId) {
      setError("Invalid Google Drive folder link.");
      return;
    }

    setIsValidatingLink(true);
    try {
      const res = await fetch(`/api/drive/folder-meta/${folderId}`, { credentials: 'include' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      setSelectedFolder(data);
      setStep(2);
    } catch (err: any) {
      setError(err.message || "Could not access the folder. Check your link or permissions.");
    } finally {
      setIsValidatingLink(false);
    }
  };

  const extractFolderId = (url: string) => {
    const match = url.match(/[-\w]{25,}/);
    return match ? match[0] : null;
  };

  const handleLogin = async () => {
    try {
      const res = await fetch('/api/auth/url', { credentials: 'include' });
      const { url } = await res.json();
      const popup = window.open(url, 'google_oauth', 'width=600,height=700');
      if (!popup || popup.closed || typeof popup.closed === 'undefined') {
        window.location.href = url;
      }
    } catch (err) {
      setError("Failed to start authentication.");
    }
  };

  const openInNewTab = () => {
    window.open(window.location.href, '_blank');
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setAuthStatus({ authenticated: false });
    resetApp();
  };

  const resetApp = () => {
    setStep(1);
    setFolderLink("");
    setSelectedFolder(null);
    setReferenceImage(null);
    setMatches([]);
    setScanProgress(0);
    setError(null);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setReferenceImage(reader.result as string);
        setStep(3);
      };
      reader.readAsDataURL(file);
    }
  };

  const startScan = async () => {
    if (!selectedFolder || !referenceImage) return;

    setIsScanning(true);
    setError(null);
    setMatches([]);
    setScanProgress(0);

    try {
      // 1. Get all photos in folder
      const photosRes = await fetch(`/api/drive/photos/${selectedFolder.id}`, { credentials: 'include' });
      const photos = await photosRes.json();
      if (photos.error) throw new Error(photos.error);

      const batchSize = 5;
      const refBase64 = referenceImage.split(',')[1];
      const foundMatches: DriveFile[] = [];

      for (let i = 0; i < photos.length; i += batchSize) {
        const batch = photos.slice(i, i + batchSize);
        setScanProgress(Math.round(((i + batch.length) / photos.length) * 100));

        const matchRes = await fetch('/api/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            referenceBase64: refBase64,
            candidateIds: batch.map((p: any) => p.id)
          })
        });

        const results = await matchRes.json();
        if (results.error) throw new Error(results.error);

        const batchMatches = results
          .filter((r: any) => r.isMatch)
          .map((r: any) => photos.find((p: any) => p.id === r.fileId)!)
          .filter(Boolean);

        foundMatches.push(...batchMatches);
        setMatches([...foundMatches]);
      }
      
      setStep(4);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "An error occurred during scanning. Ensure images are small or the batch is valid.");
    } finally {
      setIsScanning(false);
    }
  };

  if (isLoadingStatus) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-900 pb-12">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10 px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <ImageIcon className="w-5 h-5 text-white" />
          </div>
          <h1 className="font-bold text-lg tracking-tight">EventFind</h1>
        </div>
        {authStatus.authenticated && (
          <button 
            onClick={handleLogout}
            className="p-2 text-gray-400 hover:text-red-500 transition-colors"
          >
            <LogOut className="w-5 h-5" />
          </button>
        )}
      </header>

      <main className="max-w-md mx-auto px-4 mt-8">
        {!authStatus.authenticated ? (
          <section className="text-center py-6">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <div className="w-20 h-20 bg-blue-50 rounded-3xl flex items-center justify-center mx-auto mb-2">
                <Search className="w-10 h-10 text-blue-600" />
              </div>
              <div className="space-y-2">
                <h2 className="text-2xl font-bold text-gray-900">Find your photos</h2>
                <p className="text-sm text-gray-500 max-w-xs mx-auto">
                  Scan Google Drive folders and use AI to automatically find Every photo of you.
                </p>
              </div>

              <div className="bg-white p-6 rounded-[32px] shadow-sm border border-gray-100 space-y-4">
                <button 
                  onClick={handleLogin}
                  className="w-full bg-blue-600 text-white font-bold py-4 px-6 rounded-2xl shadow-lg shadow-blue-200 hover:bg-blue-700 active:scale-95 transition-all flex items-center justify-center gap-3"
                >
                  <img src="https://www.gstatic.com/images/branding/product/1x/g_32dp.png" className="w-5 h-5 brightness-0 invert" alt="" />
                  Sign in with Google
                </button>

                <div className="flex items-center gap-2 text-gray-300 py-2">
                  <div className="flex-1 h-px bg-gray-100" />
                  <span className="text-[10px] uppercase font-bold tracking-widest text-gray-400">If you get stuck</span>
                  <div className="flex-1 h-px bg-gray-100" />
                </div>

                <div className="space-y-2">
                  <button 
                    onClick={openInNewTab}
                    className="w-full bg-gray-50 text-gray-600 font-bold py-3 text-xs uppercase tracking-widest hover:bg-gray-100 rounded-xl transition-all flex items-center justify-center gap-2"
                  >
                    Open in New Tab
                  </button>
                  <button 
                    onClick={checkAuth}
                    disabled={isRefreshingAuth}
                    className="w-full bg-transparent text-blue-600 font-bold py-2 text-[10px] uppercase tracking-widest flex items-center justify-center gap-2"
                  >
                    {isRefreshingAuth ? <Loader2 className="w-3 h-3 animate-spin" /> : "Refresh Connection Status"}
                  </button>
                </div>
              </div>
              
              <p className="text-[10px] text-gray-400 px-8 leading-relaxed">
                Browser settings might block login in iframes. 
                Use <strong>Open in New Tab</strong> if standard login doesn't work.
              </p>
            </motion.div>
          </section>
        ) : (
          <section className="space-y-8">
            {/* Step Wizard */}
            <div className="flex justify-between items-center px-2">
              {[1, 2, 3, 4].map((s) => (
                <div key={s} className="flex flex-col items-center gap-1">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                    step >= s ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-400'
                  }`}>
                    {step > s ? <CheckCircle2 className="w-5 h-5" /> : s}
                  </div>
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">{
                    s === 1 ? 'Link' : s === 2 ? 'Selfie' : s === 3 ? 'Sync' : 'Done'
                  }</span>
                </div>
              ))}
            </div>

            <AnimatePresence mode="wait">
              {step === 1 && (
                <motion.div 
                  key="step1"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-6"
                >
                  <div className="space-y-2">
                    <h3 className="text-xl font-bold flex items-center gap-2">
                      <FolderOpen className="w-5 h-5 text-blue-600" />
                      Add Event Link
                    </h3>
                    <p className="text-sm text-gray-500 font-medium">Paste the Google Drive folder link from the host.</p>
                  </div>

                  <div className="space-y-4">
                    <div className="relative">
                      <input 
                        type="text"
                        value={folderLink}
                        onChange={(e) => setFolderLink(e.target.value)}
                        placeholder="https://drive.google.com/drive/folders/..."
                        className="w-full bg-white border border-gray-200 rounded-2xl py-4 px-5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-medium text-sm"
                      />
                    </div>
                    <button
                      onClick={handleAddLink}
                      disabled={!folderLink || isValidatingLink}
                      className="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 hover:bg-blue-700 active:scale-95 disabled:bg-gray-300 disabled:scale-100 transition-all shadow-md"
                    >
                      {isValidatingLink ? <Loader2 className="w-5 h-5 animate-spin" /> : "Next Step"}
                    </button>
                  </div>

                  <div className="pt-4 border-t border-gray-100">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Or choose from your folders</p>
                    <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                      {folders.map((folder) => (
                        <button
                          key={folder.id}
                          onClick={() => {
                            setSelectedFolder(folder);
                            setStep(2);
                          }}
                          className="w-full text-left p-3 bg-white border border-gray-100 rounded-xl hover:bg-blue-50 hover:border-blue-200 transition-all flex items-center justify-between group"
                        >
                          <span className="text-sm font-medium truncate pr-4">{folder.name}</span>
                          <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-blue-500 shrink-0" />
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}

              {step === 2 && (
                <motion.div 
                  key="step2"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-6 text-center"
                >
                  <div className="space-y-2">
                    <h3 className="text-xl font-bold">Face Identification</h3>
                    <p className="text-sm text-gray-500">Provide a clear selfie so AI can find you.</p>
                  </div>
                  
                  <div className="grid grid-cols-1 gap-4">
                    <button 
                      onClick={() => fileInputRef.current?.click()}
                      className="aspect-square bg-white border-2 border-dashed border-gray-200 rounded-3xl flex flex-col items-center justify-center gap-4 hover:border-blue-400 hover:bg-blue-50 transition-all group shadow-sm"
                    >
                      <div className="p-4 bg-gray-50 rounded-2xl group-hover:bg-blue-100 transition-colors">
                        <Camera className="w-8 h-8 text-gray-400 group-hover:text-blue-600" />
                      </div>
                      <span className="font-bold text-gray-600">Snap or Upload Selfie</span>
                    </button>
                    <input 
                      type="file" 
                      accept="image/*" 
                      className="hidden" 
                      ref={fileInputRef}
                      onChange={handleImageUpload}
                    />
                  </div>
                  <button onClick={() => setStep(1)} className="text-sm text-gray-400 font-bold hover:text-blue-500 transition-colors">← Back to Link</button>
                </motion.div>
              )}

              {step === 3 && (
                <motion.div 
                  key="step3"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="space-y-8 text-center py-4"
                >
                  <div className="relative w-48 h-48 mx-auto">
                    {referenceImage && (
                      <img 
                        src={referenceImage} 
                        className="w-full h-full object-cover rounded-3xl shadow-2xl ring-4 ring-white" 
                        alt="Target"
                      />
                    )}
                    {isScanning && (
                      <div className="absolute inset-0 bg-blue-600/30 backdrop-blur-[2px] rounded-3xl flex items-center justify-center">
                        <div className="w-12 h-12 border-4 border-white border-t-transparent rounded-full animate-spin shadow-lg" />
                      </div>
                    )}
                  </div>

                  <div className="space-y-4">
                    <h3 className="text-2xl font-bold">
                      {isScanning ? 'Syncing Photos' : 'Ready to Analyze'}
                    </h3>
                    <p className="text-sm text-gray-500 font-medium px-4">
                      Searching <span className="text-black font-bold">"{selectedFolder?.name}"</span>
                    </p>
                    
                    {isScanning ? (
                      <div className="space-y-3 px-2">
                        <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden shadow-inner">
                          <motion.div 
                            className="bg-blue-600 h-full"
                            initial={{ width: 0 }}
                            animate={{ width: `${scanProgress}%` }}
                          />
                        </div>
                        <p className="text-[10px] font-black text-blue-600 uppercase tracking-[0.2em]">{scanProgress}% Scanned</p>
                      </div>
                    ) : (
                      <div className="space-y-4 pt-2">
                        <button
                          onClick={startScan}
                          disabled={isScanning}
                          className="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-xl hover:bg-blue-700 active:scale-95 transition-all flex items-center justify-center gap-2"
                        >
                          <Search className="w-5 h-5" />
                          Find My Photos
                        </button>
                        <button onClick={() => setStep(2)} className="text-sm text-gray-400 font-bold">Change Selfie</button>
                      </div>
                    )}
                  </div>
                  
                  {matches.length > 0 && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="bg-green-50 p-4 rounded-2xl border border-green-100 flex items-center gap-4 text-left shadow-sm"
                    >
                      <div className="w-10 h-10 bg-green-500 rounded-xl flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-6 h-6 text-white" />
                      </div>
                      <div>
                        <p className="font-bold text-green-800 text-sm">{matches.length} matches found</p>
                        <p className="text-[10px] text-green-600 font-bold uppercase tracking-wider">Analysis continues...</p>
                      </div>
                    </motion.div>
                  )}
                </motion.div>
              )}

              {step === 4 && (
                <motion.div 
                  key="step4"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-6"
                >
                  <div className="flex items-center justify-between px-1">
                    <div>
                      <h3 className="text-2xl font-bold">Results</h3>
                      <p className="text-sm text-gray-500 font-medium">Found {matches.length} photos of you</p>
                    </div>
                    <button 
                      onClick={resetApp}
                      className="p-2.5 bg-gray-100 rounded-xl text-gray-500 hover:bg-blue-100 hover:text-blue-600 transition-colors shadow-sm"
                      title="Start over"
                    >
                      <RefreshCcw className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {matches.map((photo) => (
                      <div key={photo.id} className="relative group aspect-square rounded-2xl overflow-hidden bg-gray-200 border border-gray-100 shadow-lg">
                        <img 
                          src={photo.thumbnailLink?.replace('=s220', '=s800')} 
                          className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" 
                          alt="Match"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center pb-4">
                           <a 
                            href={photo.webContentLink} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="p-3 bg-white hover:bg-blue-50 rounded-2xl shadow-xl transition-all active:scale-90"
                          >
                            <Download className="w-5 h-5 text-blue-600" />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>

                  {matches.length === 0 && (
                    <div className="text-center py-16 space-y-6 bg-white rounded-3xl border border-gray-100 shadow-sm">
                      <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mx-auto ring-8 ring-gray-200/20">
                        <AlertCircle className="w-10 h-10 text-gray-300" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-gray-900 font-bold">No photos found</p>
                        <p className="text-sm text-gray-400 px-8 leading-relaxed">We couldn't find a match for your face in this folder. Try a clearer selfie or another event link.</p>
                      </div>
                      <button onClick={resetApp} className="text-blue-600 font-black text-sm uppercase tracking-widest">Try Again</button>
                    </div>
                  )}

                  {matches.length > 0 && (
                    <div className="bg-blue-600 p-8 rounded-[2rem] text-white shadow-2xl shadow-blue-200 text-center space-y-5">
                      <p className="font-bold text-lg">Great news!</p>
                      <p className="text-sm text-blue-100 opacity-90 leading-relaxed font-medium">Download individual photos above or visit the shared folder to see everything.</p>
                      <button 
                        onClick={() => window.open(`https://drive.google.com/drive/folders/${selectedFolder?.id}`, '_blank')}
                        className="w-full bg-white text-blue-600 font-black py-4 rounded-2xl flex items-center justify-center gap-3 transition-transform active:scale-95 shadow-lg"
                      >
                        <FolderOpen className="w-5 h-5" />
                        Open Shared Folder
                      </button>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {error && (
              <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-bold text-red-800">Something went wrong</p>
                  <p className="text-xs text-red-600">{error}</p>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      {/* Footer Branding */}
      <footer className="text-center mt-12 opacity-30">
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">AI Powered Photo Recognition</p>
      </footer>
    </div>
  );
}
