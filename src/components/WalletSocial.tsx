import { useEffect, useState } from 'react';
import { getProfiles, getScorecards, listIdeas, saveProfile, socialEnabled, type Idea, type Profile, type Scorecard } from '../social/client';
import { validateProfile } from '../../supabase/functions/_shared/proof';
import { errorText, useWallet } from '../wallet/WalletContext';
import { IdeaCard } from './IdeaCard';

/** Profile header, profile editor (own wallet only) and the wallet's trade ideas. */
export function WalletSocial({ address, onRoute }: { address: string; onRoute: (h: string) => void }) {
  const w = useWallet();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [editing, setEditing] = useState(false);
  const [reload, setReload] = useState(0);
  const mine = w.address?.toLowerCase() === address.toLowerCase();

  useEffect(() => {
    if (!socialEnabled) return;
    getProfiles([address]).then((m) => setProfile(m.get(address.toLowerCase()) ?? null)).catch(() => {});
    listIdeas({ author: address, limit: 20 }).then(setIdeas).catch(() => {});
  }, [address, reload]);

  if (!socialEnabled) return null;
  return (
    <div className="wallet-social">
      <div className="profile-row">
        {profile ? (
          <>
            <strong>{profile.display_name}</strong>
            {profile.twitter && (
              <a className="muted" href={`https://x.com/${profile.twitter}`} target="_blank" rel="noreferrer">
                @{profile.twitter}
              </a>
            )}
            {profile.bio && <span className="muted">{profile.bio}</span>}
          </>
        ) : (
          <span className="muted">No HyperSpace profile yet.</span>
        )}
        {mine && !editing && (
          <button onClick={() => setEditing(true)}>{profile ? 'Edit profile' : 'Create profile'}</button>
        )}
      </div>
      {mine && editing && (
        <ProfileForm
          initial={profile}
          onDone={(saved) => {
            setEditing(false);
            if (saved) setReload((n) => n + 1);
          }}
        />
      )}
      <IdeaScorecard address={address} ideas={ideas.length} />
      <h3>Trade ideas ({ideas.length})</h3>
      {ideas.length === 0 ? (
        <div className="muted small">This wallet has not posted any ideas.</div>
      ) : (
        ideas.map((i) => <IdeaCard key={i.id} idea={i} profile={profile ?? undefined} onRoute={onRoute} />)
      )}
    </div>
  );
}

function ProfileForm({ initial, onDone }: { initial: Profile | null; onDone: (saved: boolean) => void }) {
  const w = useWallet();
  const [displayName, setName] = useState(initial?.display_name ?? '');
  const [bio, setBio] = useState(initial?.bio ?? '');
  const [twitter, setTwitter] = useState(initial?.twitter ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = validateProfile({ displayName, bio, twitter });
    if (typeof p === 'string') return setErr(p);
    setBusy(true);
    setErr('');
    try {
      await saveProfile(w.address!, p, w.signMessage);
      onDone(true);
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="idea-form" onSubmit={submit}>
      <div className="row">
        <input placeholder="Display name" value={displayName} onChange={(e) => setName(e.target.value)} />
        <input placeholder="X handle (optional)" value={twitter} onChange={(e) => setTwitter(e.target.value)} />
      </div>
      <textarea placeholder="Short bio (optional, 280 characters)" value={bio} onChange={(e) => setBio(e.target.value)} rows={2} />
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Check your wallet…' : 'Sign and save'}
        </button>
        <button type="button" onClick={() => onDone(false)}>
          Cancel
        </button>
        {err && <span className="warn-text">{err}</span>}
      </div>
    </form>
  );
}

/** Track record of this wallet's ideas: how many hit their target before their stop. */
function IdeaScorecard({ address, ideas }: { address: string; ideas: number }) {
  const [card, setCard] = useState<Scorecard | null | undefined>(undefined);
  useEffect(() => {
    getScorecards([address])
      .then((m) => setCard(m.get(address.toLowerCase()) ?? null))
      .catch(() => setCard(null));
  }, [address]);
  if (!ideas || card === undefined) return null;
  if (!card || !card.resolved)
    return <div className="muted small">Idea scorecard: no ideas have resolved yet (an idea resolves when price reaches its target or its stop).</div>;
  const rate = card.hit_rate ?? card.targets / card.resolved;
  return (
    <div className="cards">
      <div className="card">
        <small className="muted">Ideas posted</small>
        {card.ideas}
      </div>
      <div className="card">
        <small className="muted">Hit target</small>
        <span className="up">{card.targets}</span>
      </div>
      <div className="card">
        <small className="muted">Stopped out</small>
        <span className="down">{card.stops}</span>
      </div>
      <div className="card">
        <small className="muted">Hit rate</small>
        {(rate * 100).toFixed(0)}%
      </div>
      {card.avg_move !== null && (
        <div className="card">
          <small className="muted">Avg move in idea's direction</small>
          <span className={card.avg_move >= 0 ? 'up' : 'down'}>
            {card.avg_move >= 0 ? '+' : ''}
            {(card.avg_move * 100).toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  );
}
