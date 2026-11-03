import AsyncStorage from '@react-native-async-storage/async-storage';
import mobileAds, {
  AdEventType,
  AdsConsent,
  AdsConsentPrivacyOptionsRequirementStatus,
  InterstitialAd,
  TestIds,
} from 'react-native-google-mobile-ads';
import { ErrorCode, getAvailablePurchases, isUserCancelledError, useIAP, type Purchase } from 'expo-iap';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { FULL_EXAM_SHARE, QUESTIONS, TOPICS, type Source, type Topic } from './questions';

type Mode = 'timed' | 'study';
type Screen = 'home' | 'exam' | 'results';

type AttemptResult = {
  score: number;
  correct: number;
  total: number;
  topic: string;
  completedAt: string;
};

const RESULT_STORAGE_KEY = 'fieldnotes.latestAttempt';
const QUESTIONS_PER_AD = 10;
const AD_LOAD_TIMEOUT_MS = 8000;
// With EXPO_PUBLIC_DISABLE_ADS=true there is no ad unit, so the app never asks
// for consent, initializes the ads SDK, or pauses for an ad break.
const ADS_DISABLED = process.env.EXPO_PUBLIC_DISABLE_ADS === 'true';
const INTERSTITIAL_AD_UNIT_ID = ADS_DISABLED
  ? undefined
  : __DEV__
    ? TestIds.INTERSTITIAL
    : process.env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_ID;
// One-time Google Play product that turns ads off. The purchase is cached locally so
// the app starts ad-free offline, and re-checked with Play on every launch.
const REMOVE_ADS_SKU = 'remove_ads';
const ADS_REMOVED_STORAGE_KEY = 'fieldnotes.adsRemoved';

const EXAM_LENGTH = 10;
const FULL_EXAM_LENGTH = 60;
// Study sessions and topic drills draw this many questions from the bank.
const SESSION_LENGTH = 20;
const SECONDS_PER_QUESTION = 2 * 60;

function SourceNote({ source }: { source: Source }) {
  return (
    <View style={styles.sourceNote}>
      <Text style={styles.sourceKicker}>SOURCE</Text>
      <Text style={styles.sourceQuote}>“{source.quote}”</Text>
      <Text
        accessibilityRole="link"
        onPress={() => Linking.openURL(source.url).catch(() => {})}
        style={styles.sourceLink}
      >
        {source.title}{source.section ? ` › ${source.section}` : ''}
      </Text>
    </View>
  );
}

function logAd(event: string, detail?: unknown) {
  if (__DEV__) console.log(`[ads] ${event}`, detail ?? '');
}

function shuffle<T>(items: T[]) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

const COLORS = {
  background: '#F4F7F1',
  paper: '#FFFFFF',
  ink: '#19332B',
  muted: '#738078',
  line: '#E0E8DF',
  green: '#2E6A50',
  greenDark: '#183B2E',
  lime: '#D8F27A',
  orange: '#F08C68',
  paleGreen: '#EAF3E8',
  paleOrange: '#FFF0E9',
};

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [mode, setMode] = useState<Mode>('timed');
  const [questions, setQuestions] = useState(QUESTIONS.slice(0, EXAM_LENGTH));
  const [topicFilter, setTopicFilter] = useState<Topic | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState<number[]>([]);
  const [flagged, setFlagged] = useState<number[]>([]);
  const [secondsLeft, setSecondsLeft] = useState(EXAM_LENGTH * SECONDS_PER_QUESTION);
  const [fullExam, setFullExam] = useState(false);
  const [latestResult, setLatestResult] = useState<AttemptResult | null>(null);
  const [quickSet, setQuickSet] = useState(false);
  const [adStatus, setAdStatus] = useState<'idle' | 'loading' | 'showing'>('idle');
  const [nextAdAt, setNextAdAt] = useState(QUESTIONS_PER_AD);
  const interstitialRef = useRef<InterstitialAd | null>(null);
  const adTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adsInitializedRef = useRef(false);
  const adsInitializationFailedRef = useRef(false);
  const [privacyOptionsRequired, setPrivacyOptionsRequired] = useState(false);
  const pendingAdActionRef = useRef<(() => void) | null>(null);
  // null until the cached purchase state has been read, so ads don't start for a buyer.
  const [adsRemoved, setAdsRemoved] = useState<boolean | null>(null);
  const [purchaseBusy, setPurchaseBusy] = useState(false);

  const { connected, products, fetchProducts, requestPurchase, finishTransaction } = useIAP({
    onPurchaseSuccess: (purchase) => {
      setPurchaseBusy(false);
      if (purchase.productId !== REMOVE_ADS_SKU) return;
      if (purchase.purchaseState === 'pending') {
        Alert.alert('Payment pending', 'Ads will turn off once Google Play confirms your payment.');
        return;
      }
      grantRemoveAds(purchase);
    },
    onPurchaseError: (error) => {
      setPurchaseBusy(false);
      if (error.code === ErrorCode.AlreadyOwned) {
        restorePurchase(true);
      } else if (!isUserCancelledError(error)) {
        Alert.alert('Purchase failed', error.message);
      }
    },
  });
  const removeAdsProduct = products.find((product) => product.id === REMOVE_ADS_SKU);

  function saveAdsRemoved(removed: boolean) {
    setAdsRemoved(removed);
    AsyncStorage.setItem(ADS_REMOVED_STORAGE_KEY, String(removed)).catch(() => {});
  }

  // Play refunds purchases that aren't acknowledged within three days.
  function grantRemoveAds(purchase: Purchase) {
    saveAdsRemoved(true);
    if ('isAcknowledgedAndroid' in purchase && purchase.isAcknowledgedAndroid) return;
    finishTransaction({ purchase, isConsumable: false }).catch((error: unknown) => logAd('acknowledge failed', error));
  }

  // Syncs with Play: grants a completed purchase and revokes a refunded one.
  function restorePurchase(showResult = false) {
    getAvailablePurchases()
      .then((purchases) => {
        const purchase = purchases.find(
          (item) => item.productId === REMOVE_ADS_SKU && item.purchaseState === 'purchased',
        );
        if (purchase) grantRemoveAds(purchase);
        else saveAdsRemoved(false);
        if (showResult) {
          Alert.alert(
            purchase ? 'Ads removed' : 'No purchase found',
            purchase ? 'Your purchase was restored.' : 'This Google account has not bought ad removal.',
          );
        }
      })
      .catch((error: unknown) => {
        logAd('restore failed', error);
        if (showResult) Alert.alert('Could not reach Google Play', 'Check your connection and try again.');
      });
  }

  function buyRemoveAds() {
    setPurchaseBusy(true);
    requestPurchase({ request: { google: { skus: [REMOVE_ADS_SKU] } }, type: 'in-app' }).catch(() => setPurchaseBusy(false));
  }

  const timedLength = fullExam ? FULL_EXAM_LENGTH : EXAM_LENGTH;
  const currentQuestion = questions[questionIndex];
  const correctCount = questions.reduce(
    (total, question) => total + (answers[question.id] === question.answer ? 1 : 0),
    0,
  );
  const answeredCount = questions.filter((question) => answers[question.id] !== undefined).length;
  const isAnswerChecked = checked.includes(currentQuestion?.id ?? -1);
  const selectedAnswer = currentQuestion ? answers[currentQuestion.id] : undefined;

  function clearAdTimeout() {
    if (adTimeoutRef.current) clearTimeout(adTimeoutRef.current);
    adTimeoutRef.current = null;
  }

  function completeAdBreak() {
    clearAdTimeout();
    const action = pendingAdActionRef.current;
    pendingAdActionRef.current = null;
    setAdStatus('idle');
    action?.();
  }

  // The ad object ignores load() while it is already loaded or loading.
  function loadInterstitial(ad: InterstitialAd | null = interstitialRef.current) {
    if (!ad || !adsInitializedRef.current) return;
    logAd('load requested');
    ad.load();
  }

  function showInterstitial(ad: InterstitialAd) {
    clearAdTimeout();
    setAdStatus('showing');
    ad.show().catch((error: unknown) => {
      logAd('show failed', error);
      completeAdBreak();
    });
  }

  function continueAfterQuestionBatch(action: () => void) {
    if (answeredCount < nextAdAt) {
      action();
      return;
    }

    setNextAdAt((milestone) => milestone + QUESTIONS_PER_AD);
    const ad = interstitialRef.current;
    if (!ad || adsInitializationFailedRef.current) {
      logAd('break skipped: ads unavailable');
      action();
      return;
    }

    logAd(`break after ${answeredCount} answers`, { loaded: ad.loaded });
    pendingAdActionRef.current = action;
    setAdStatus('loading');
    if (ad.loaded) {
      showInterstitial(ad);
      return;
    }
    adTimeoutRef.current = setTimeout(() => {
      logAd('break skipped: load timed out');
      completeAdBreak();
    }, AD_LOAD_TIMEOUT_MS);
    loadInterstitial(ad);
  }

  useEffect(() => {
    let isActive = true;
    AsyncStorage.getItem(RESULT_STORAGE_KEY)
      .then((storedResult) => {
        if (storedResult && isActive) setLatestResult(JSON.parse(storedResult) as AttemptResult);
      })
      .catch(() => {});
    AsyncStorage.getItem(ADS_REMOVED_STORAGE_KEY)
      .then((stored) => { if (isActive) setAdsRemoved((current) => current ?? stored === 'true'); })
      .catch(() => { if (isActive) setAdsRemoved((current) => current ?? false); });
    return () => { isActive = false; };
  }, []);

  useEffect(() => {
    if (ADS_DISABLED || !connected) return;
    fetchProducts({ skus: [REMOVE_ADS_SKU], type: 'in-app' }).catch((error: unknown) => logAd('product fetch failed', error));
    restorePurchase();
  }, [connected]);

  useEffect(() => {
    if (!INTERSTITIAL_AD_UNIT_ID || adsRemoved !== false) return;

    const ad = InterstitialAd.createForAdRequest(INTERSTITIAL_AD_UNIT_ID);
    interstitialRef.current = ad;
    adsInitializationFailedRef.current = false;
    ad.addAdEventListener(AdEventType.LOADED, () => {
      logAd('loaded');
      if (pendingAdActionRef.current) showInterstitial(ad);
    });
    ad.addAdEventListener(AdEventType.OPENED, () => {
      logAd('opened');
      setAdStatus('showing');
    });
    ad.addAdEventListener(AdEventType.CLOSED, () => {
      logAd('closed');
      completeAdBreak();
      loadInterstitial(ad);
    });
    ad.addAdEventListener(AdEventType.ERROR, (error) => {
      logAd('error', error);
      completeAdBreak();
    });

    // Ask for consent where required (EEA, UK, Switzerland) before requesting ads.
    // If the update fails, fall back to the consent stored from an earlier session.
    AdsConsent.gatherConsent()
      .catch((error: unknown) => logAd('consent update failed', error))
      .then(() => AdsConsent.getConsentInfo())
      .then((consent) => {
        setPrivacyOptionsRequired(
          consent.privacyOptionsRequirementStatus === AdsConsentPrivacyOptionsRequirementStatus.REQUIRED,
        );
        if (!consent.canRequestAds) throw new Error('consent does not allow ad requests');
        return mobileAds().initialize();
      })
      .then(() => {
        logAd('initialized');
        adsInitializedRef.current = true;
        loadInterstitial(ad);
      })
      .catch((error: unknown) => {
        logAd('initialization failed', error);
        adsInitializationFailedRef.current = true;
        completeAdBreak();
      });

    return () => {
      adsInitializedRef.current = false;
      interstitialRef.current = null;
      completeAdBreak();
      ad.destroy();
    };
  }, [adsRemoved]);

  useEffect(() => {
    if (screen !== 'exam' || mode !== 'timed' || adStatus !== 'idle') return;
    const timer = setInterval(() => setSecondsLeft((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timer);
  }, [screen, mode, adStatus]);

  useEffect(() => {
    if (screen === 'exam' && mode === 'timed' && adStatus === 'idle' && secondsLeft === 0) {
      continueAfterQuestionBatch(finishExam);
    }
  }, [screen, mode, adStatus, secondsLeft]);

  function startSession(nextMode: Mode, topic: Topic | null = null, quick = false) {
    // The full exam draws from every domain by its exam weight; other sessions draw at random.
    const drawn = nextMode === 'timed' && !topic && !quick && fullExam
      ? shuffle(TOPICS.flatMap((examTopic) =>
          shuffle(QUESTIONS.filter((question) => question.topic === examTopic)).slice(0, FULL_EXAM_SHARE[examTopic]),
        ))
      : shuffle(topic ? QUESTIONS.filter((question) => question.topic === topic) : QUESTIONS)
          .slice(0, quick ? 5 : nextMode === 'timed' && !topic ? EXAM_LENGTH : SESSION_LENGTH);
    const sessionQuestions = drawn.map((question) => {
      const options = shuffle(question.options);
      return { ...question, options, answer: options.indexOf(question.options[question.answer]) };
    });
    setMode(nextMode);
    setTopicFilter(topic);
    setQuickSet(quick);
    setQuestions(sessionQuestions);
    setQuestionIndex(0);
    setAnswers({});
    setChecked([]);
    setFlagged([]);
    setNextAdAt(QUESTIONS_PER_AD);
    pendingAdActionRef.current = null;
    setAdStatus('idle');
    setSecondsLeft(sessionQuestions.length * SECONDS_PER_QUESTION);
    setScreen('exam');
  }

  function finishExam() {
    const result: AttemptResult = {
      score: Math.round((correctCount / questions.length) * 100),
      correct: correctCount,
      total: questions.length,
      topic: topicFilter ?? 'All topics',
      completedAt: new Date().toISOString(),
    };
    setLatestResult(result);
    AsyncStorage.setItem(RESULT_STORAGE_KEY, JSON.stringify(result)).catch(() => {});
    setScreen('results');
  }

  function chooseAnswer(optionIndex: number) {
    if (!currentQuestion) return;
    setAnswers((previous) => ({ ...previous, [currentQuestion.id]: optionIndex }));
    setChecked((previous) => previous.filter((id) => id !== currentQuestion.id));
  }

  function checkAnswer() {
    if (!currentQuestion || selectedAnswer === undefined) return;
    setChecked((previous) => [...previous, currentQuestion.id]);
  }

  function moveQuestion(direction: number) {
    const nextIndex = questionIndex + direction;
    if (nextIndex < 0) return;
    const advance = () => {
      if (nextIndex >= questions.length) finishExam();
      else setQuestionIndex(nextIndex);
    };
    if (direction > 0) {
      continueAfterQuestionBatch(advance);
      return;
    }
    advance();
  }

  function leaveSession() {
    Alert.alert('Leave this session?', 'Your answers will not be saved.', [
      { text: 'Keep going', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          pendingAdActionRef.current = null;
          setAdStatus('idle');
          setScreen('home');
        },
      },
    ]);
  }

  function toggleFlag() {
    if (!currentQuestion) return;
    setFlagged((previous) =>
      previous.includes(currentQuestion.id)
        ? previous.filter((id) => id !== currentQuestion.id)
        : [...previous, currentQuestion.id],
    );
  }

  function formatTime(totalSeconds: number) {
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      {screen === 'home' && (
        <ScrollView contentContainerStyle={styles.homeContent} showsVerticalScrollIndicator={false}>
          <View style={styles.header}>
            <View style={styles.brandMark}><Text style={styles.brandMarkText}>F</Text></View>
            <View style={styles.brandCopy}>
              <Text style={styles.brandName}>FIELDNOTES</Text>
              <Text style={styles.brandSub}>AI SYSTEMS PRACTICE</Text>
            </View>
            <View style={styles.edition}><Text style={styles.editionText}>01</Text></View>
          </View>

          <View style={styles.intro}>
            <Text style={styles.eyebrow}>AI SOLUTION ARCHITECTURE PRACTICE</Text>
            <Text style={styles.headline}>Make good{ '\n'}systems choices.</Text>
            <Text style={styles.introText}>A focused practice desk for designing useful, reliable AI solutions.</Text>
          </View>

          <View style={styles.modeSwitch}>
            <Pressable onPress={() => setMode('timed')} style={[styles.modeButton, mode === 'timed' && styles.modeButtonActive]}>
              <Text style={[styles.modeButtonText, mode === 'timed' && styles.modeButtonTextActive]}>Timed exam</Text>
            </Pressable>
            <Pressable onPress={() => setMode('study')} style={[styles.modeButton, mode === 'study' && styles.modeButtonActive]}>
              <Text style={[styles.modeButtonText, mode === 'study' && styles.modeButtonTextActive]}>Study mode</Text>
            </Pressable>
          </View>

          <View style={styles.examCard}>
            <View style={styles.examCardTop}>
              <View>
                <Text style={styles.cardEyebrow}>{mode === 'timed' ? 'FULL-LENGTH SIMULATION' : 'GUIDED PRACTICE'}</Text>
                <Text style={styles.examCardTitle}>{mode === 'timed' ? 'The foundations run' : 'Learn as you go'}</Text>
              </View>
              <View style={styles.cardStamp}><Text style={styles.cardStampText}>{mode === 'timed' ? '01' : '02'}</Text></View>
            </View>
            <Text style={styles.examCardBody}>
              {mode === 'timed'
                ? `${timedLength} original questions across the five exam domains.`
                : 'Answer at your own pace. Check each response to see the reasoning.'}
            </Text>
            {mode === 'timed' && (
              <View style={styles.lengthSwitch}>
                {[false, true].map((full) => (
                  <Pressable
                    key={String(full)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: fullExam === full }}
                    onPress={() => setFullExam(full)}
                    style={[styles.lengthButton, fullExam === full && styles.lengthButtonActive]}
                  >
                    <Text style={[styles.lengthButtonText, fullExam === full && styles.lengthButtonTextActive]}>
                      {full ? `Full ${FULL_EXAM_LENGTH}` : `${EXAM_LENGTH} questions`}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            <View style={styles.examMetaRow}>
              <Text style={styles.examMeta}>{mode === 'timed' ? `${timedLength} QUESTIONS` : `${SESSION_LENGTH} QUESTIONS`}</Text>
              <View style={styles.metaDot} />
              <Text style={styles.examMeta}>{mode === 'timed' ? `${(timedLength * SECONDS_PER_QUESTION) / 60} MIN` : 'NO TIMER'}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => startSession(mode)}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
            >
              <Text style={styles.primaryButtonText}>{mode === 'timed' ? 'Start timed exam' : 'Start study session'}</Text>
              <Text style={styles.primaryArrow}>›</Text>
            </Pressable>
          </View>

          <View style={styles.quickRow}>
            <View style={styles.quickCopy}>
              <Text style={styles.quickTitle}>Short on time?</Text>
              <Text style={styles.quickBody}>Try a 5-question warm-up.</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={() => startSession('study', null, true)} style={styles.quickButton}>
              <Text style={styles.quickButtonText}>Quick set  +</Text>
            </Pressable>
          </View>

          {latestResult && (
            <View style={styles.recentResult}>
              <View style={styles.recentResultCopy}>
                <Text style={styles.recentResultLabel}>LAST RESULT</Text>
                <Text style={styles.recentResultTopic}>{latestResult.topic}</Text>
              </View>
              <Text style={styles.recentResultScore}>{latestResult.score}%</Text>
            </View>
          )}

          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>Study by topic</Text>
            <Text style={styles.sectionNote}>{QUESTIONS.length} QUESTIONS</Text>
          </View>
          <View style={styles.topicList}>
            {TOPICS.map((topic, index) => {
              const count = QUESTIONS.filter((question) => question.topic === topic).length;
              return (
                <Pressable key={topic} onPress={() => startSession('study', topic)} style={styles.topicRow}>
                  <View style={[styles.topicNumber, index === 0 && styles.topicNumberHighlight]}>
                    <Text style={[styles.topicNumberText, index === 0 && styles.topicNumberTextHighlight]}>{String(index + 1).padStart(2, '0')}</Text>
                  </View>
                  <View style={styles.topicCopy}>
                    <Text style={styles.topicName}>{topic}</Text>
                    <Text style={styles.topicCount}>{count} QUESTIONS</Text>
                  </View>
                  <Text style={styles.topicArrow}>›</Text>
                </Pressable>
              );
            })}
          </View>

          {!ADS_DISABLED && adsRemoved === false && removeAdsProduct && (
            <View style={styles.quickRow}>
              <View style={styles.quickCopy}>
                <Text style={styles.quickTitle}>Study without breaks</Text>
                <Text style={styles.quickBody}>Remove ads with a one-time purchase.</Text>
                <Pressable accessibilityRole="button" onPress={() => restorePurchase(true)} style={styles.privacyButton}>
                  <Text style={styles.privacyButtonText}>Restore purchase</Text>
                </Pressable>
              </View>
              <Pressable
                accessibilityRole="button"
                disabled={purchaseBusy}
                onPress={buyRemoveAds}
                style={[styles.quickButton, purchaseBusy && styles.pressed]}
              >
                <Text style={styles.quickButtonText}>Remove ads · {removeAdsProduct.displayPrice}</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.footerNote}>
            <Text style={styles.footerRule} />
            <Text style={styles.footerText}>Independent study tool. Not affiliated with Anthropic. Questions are original practice material, not official exam content.</Text>
            {adsRemoved && <Text style={[styles.footerText, styles.footerThanks]}>Ads removed. Thanks for supporting the app.</Text>}
            {privacyOptionsRequired && !adsRemoved && (
              <Pressable
                accessibilityRole="button"
                onPress={() => AdsConsent.showPrivacyOptionsForm().catch((error: unknown) => logAd('privacy options failed', error))}
                style={styles.privacyButton}
              >
                <Text style={styles.privacyButtonText}>Privacy choices</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      )}

      {screen === 'exam' && currentQuestion && (
        <ScrollView contentContainerStyle={styles.examContent} showsVerticalScrollIndicator={false}>
          <View style={styles.examHeader}>
            <Pressable accessibilityRole="button" accessibilityLabel="Leave session" onPress={leaveSession} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>×</Text>
            </Pressable>
            <View style={styles.examHeaderCopy}>
              <Text style={styles.examHeaderKicker}>{mode === 'timed' ? 'TIMED EXAM' : 'STUDY SESSION'}</Text>
              <Text style={styles.examHeaderTitle}>{topicFilter ?? 'Foundations'}</Text>
            </View>
            {mode === 'timed' ? (
              <View style={[styles.timerPill, secondsLeft < 120 && styles.timerPillUrgent]}>
                <Text style={[styles.timerText, secondsLeft < 120 && styles.timerTextUrgent]}>{formatTime(secondsLeft)}</Text>
              </View>
            ) : <View style={styles.timerSpacer} />}
          </View>

          <View style={styles.progressInfo}>
            <Text style={styles.progressLabel}>QUESTION {String(questionIndex + 1).padStart(2, '0')} <Text style={styles.progressDivider}>/</Text> {String(questions.length).padStart(2, '0')}</Text>
            <Text style={styles.progressLabel}>{answeredCount} ANSWERED</Text>
          </View>
          <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${((questionIndex + 1) / questions.length) * 100}%` }]} /></View>
          {adStatus === 'loading' && (
            <View style={styles.adPauseNotice}>
              <Text style={styles.adPauseTitle}>Preparing an ad break</Text>
              <Text style={styles.adPauseText}>{mode === 'timed' ? 'Your exam timer is paused.' : 'Your session is paused.'}</Text>
            </View>
          )}

          {mode === 'timed' && (
            <View style={styles.navigator}>
              {questions.map((question, index) => {
                const isCurrent = index === questionIndex;
                const isAnswered = answers[question.id] !== undefined;
                const isFlagged = flagged.includes(question.id);
                return (
                  <Pressable
                    key={question.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Go to question ${index + 1}${isAnswered ? ', answered' : ''}${isFlagged ? ', flagged' : ''}`}
                    onPress={() => setQuestionIndex(index)}
                    style={[styles.navigatorItem, isCurrent && styles.navigatorItemCurrent, isAnswered && !isCurrent && styles.navigatorItemAnswered]}
                  >
                    <Text style={[styles.navigatorText, (isCurrent || isAnswered) && styles.navigatorTextActive]}>{index + 1}</Text>
                    {isFlagged && <View style={styles.flagDot} />}
                  </Pressable>
                );
              })}
            </View>
          )}

          <View style={styles.questionHeading}>
            <View style={styles.topicPill}><Text style={styles.topicPillText}>{currentQuestion.topic.toUpperCase()}</Text></View>
            <Pressable accessibilityRole="button" onPress={toggleFlag} style={[styles.flagButton, flagged.includes(currentQuestion.id) && styles.flagButtonActive]}>
              <Text style={[styles.flagButtonText, flagged.includes(currentQuestion.id) && styles.flagButtonTextActive]}>{flagged.includes(currentQuestion.id) ? 'FLAGGED' : 'FLAG FOR REVIEW'}</Text>
            </Pressable>
          </View>

          <Text style={styles.questionText}>{currentQuestion.prompt}</Text>
          <Text style={styles.selectHint}>{mode === 'timed' ? 'SELECT ONE ANSWER' : 'CHOOSE AN ANSWER TO CHECK YOUR THINKING'}</Text>

          <View style={styles.optionsList}>
            {currentQuestion.options.map((option, index) => {
              const isSelected = selectedAnswer === index;
              const isCorrect = isAnswerChecked && index === currentQuestion.answer;
              const isWrong = isAnswerChecked && isSelected && !isCorrect;
              return (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => !isAnswerChecked && chooseAnswer(index)}
                  style={[styles.option, isSelected && styles.optionSelected, isCorrect && styles.optionCorrect, isWrong && styles.optionWrong]}
                >
                  <View style={[styles.optionLetter, isSelected && styles.optionLetterSelected, isCorrect && styles.optionLetterCorrect, isWrong && styles.optionLetterWrong]}>
                    <Text style={[styles.optionLetterText, (isSelected || isCorrect) && styles.optionLetterTextActive]}>{String.fromCharCode(65 + index)}</Text>
                  </View>
                  <Text style={[styles.optionText, (isSelected || isCorrect) && styles.optionTextActive]}>{option}</Text>
                </Pressable>
              );
            })}
          </View>

          {mode === 'study' && isAnswerChecked && (
            <View style={[styles.explanationBox, selectedAnswer === currentQuestion.answer ? styles.explanationCorrect : styles.explanationReview]}>
              <Text style={[styles.explanationKicker, selectedAnswer === currentQuestion.answer ? styles.explanationKickerCorrect : styles.explanationKickerReview]}>
                {selectedAnswer === currentQuestion.answer ? 'NICE REASONING' : 'REVIEW THE TRADE-OFF'}
              </Text>
              <Text style={styles.explanationText}>{currentQuestion.explanation}</Text>
              <SourceNote source={currentQuestion.source} />
            </View>
          )}

          <View style={styles.questionActions}>
            {questionIndex > 0 ? (
              <Pressable onPress={() => moveQuestion(-1)} style={styles.backButton}><Text style={styles.backButtonText}>Previous</Text></Pressable>
            ) : <View />}
            {mode === 'study' && !isAnswerChecked ? (
              <Pressable disabled={selectedAnswer === undefined} onPress={checkAnswer} style={[styles.actionButton, selectedAnswer === undefined && styles.actionButtonDisabled]}>
                <Text style={styles.actionButtonText}>Check answer</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => moveQuestion(1)}
                style={styles.actionButton}
              >
                <Text style={styles.actionButtonText}>{questionIndex === questions.length - 1 ? 'Finish session' : 'Next question'}</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      )}

      {screen === 'results' && (
        <ScrollView contentContainerStyle={styles.resultsContent} showsVerticalScrollIndicator={false}>
          <View style={styles.header}>
            <View style={styles.brandMark}><Text style={styles.brandMarkText}>F</Text></View>
            <View style={styles.brandCopy}><Text style={styles.brandName}>FIELDNOTES</Text><Text style={styles.brandSub}>SESSION REVIEW</Text></View>
            <View style={styles.edition}><Text style={styles.editionText}>01</Text></View>
          </View>
          <Text style={styles.eyebrow}>{mode === 'timed' ? 'SIMULATION COMPLETE' : 'STUDY SESSION COMPLETE'}</Text>
          <Text style={styles.resultsHeadline}>A useful{ '\n'}next step.</Text>
          <View style={styles.scoreCard}>
            <Text style={styles.scoreKicker}>YOUR SCORE</Text>
            <View style={styles.scoreLine}>
              <Text style={styles.scoreValue}>{Math.round((correctCount / questions.length) * 100)}</Text>
              <Text style={styles.scorePercent}>%</Text>
              <View style={styles.scoreDetail}><Text style={styles.scoreDetailMain}>{correctCount} of {questions.length} correct</Text><Text style={styles.scoreDetailSub}>{answeredCount} answered</Text></View>
            </View>
            <View style={styles.scoreRule} />
            <Text style={styles.scoreMessage}>
              {correctCount === questions.length
                ? 'Strong work. Keep testing your reasoning on new scenarios.'
                : 'Review the explanations, then try another set to reinforce the trade-offs.'}
            </Text>
          </View>
          <Text style={styles.sectionTitle}>Review by topic</Text>
          {TOPICS.filter((topic) => questions.some((question) => question.topic === topic)).map((topic) => {
            const topicQuestions = questions.filter((question) => question.topic === topic);
            const topicCorrect = topicQuestions.filter((question) => answers[question.id] === question.answer).length;
            return (
              <View key={topic} style={styles.resultTopic}>
                <View style={styles.resultTopicTop}><Text style={styles.resultTopicName}>{topic}</Text><Text style={styles.resultTopicCount}>{topicCorrect}/{topicQuestions.length}</Text></View>
                <View style={styles.resultTrack}><View style={[styles.resultFill, { width: `${(topicCorrect / topicQuestions.length) * 100}%` }]} /></View>
              </View>
            );
          })}
          <Text style={styles.reviewHeading}>Answer review</Text>
          <View style={styles.reviewList}>
            {questions.map((question, index) => {
              const pickedAnswer = answers[question.id];
              const wasCorrect = pickedAnswer === question.answer;
              return (
                <View key={question.id} style={styles.reviewItem}>
                  <View style={styles.reviewMeta}>
                    <Text style={styles.reviewNumber}>QUESTION {String(index + 1).padStart(2, '0')}</Text>
                    <Text style={[styles.reviewOutcome, wasCorrect ? styles.reviewOutcomeCorrect : styles.reviewOutcomeMissed]}>
                      {wasCorrect ? 'CORRECT' : pickedAnswer === undefined ? 'SKIPPED' : 'REVISIT'}
                    </Text>
                  </View>
                  <Text style={styles.reviewPrompt}>{question.prompt}</Text>
                  <Text style={styles.reviewAnswer}>Best answer: {question.options[question.answer]}</Text>
                  {!wasCorrect && <Text style={styles.reviewYourAnswer}>Your answer: {pickedAnswer === undefined ? 'Not answered' : question.options[pickedAnswer]}</Text>}
                  <Text style={styles.reviewExplanation}>{question.explanation}</Text>
                  <SourceNote source={question.source} />
                </View>
              );
            })}
          </View>
          <View style={styles.resultActions}>
            <Pressable onPress={() => startSession(mode, topicFilter, quickSet)} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Try again</Text><Text style={styles.primaryArrow}>›</Text>
            </Pressable>
            <Pressable onPress={() => { setMode('timed'); setTopicFilter(null); setScreen('home'); }} style={styles.homeButton}>
              <Text style={styles.homeButtonText}>Back to practice desk</Text>
            </Pressable>
          </View>
          {latestResult && <Text style={styles.latestScoreNote}>LATEST RESULT  |  {latestResult.score}%</Text>}
          <Text style={styles.resultsDisclaimer}>Unofficial practice material. This score is for self-study and is not an exam result or certification.</Text>
        </ScrollView>
      )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  homeContent: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 36 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 30 },
  brandMark: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.greenDark },
  brandMarkText: { color: COLORS.lime, fontSize: 20, fontWeight: '800' },
  brandCopy: { marginLeft: 11, flex: 1 },
  brandName: { color: COLORS.ink, fontSize: 12, fontWeight: '800', letterSpacing: 1.4 },
  brandSub: { color: COLORS.muted, fontSize: 9, fontWeight: '700', marginTop: 3, letterSpacing: 1.1 },
  edition: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  editionText: { color: COLORS.muted, fontSize: 11, fontWeight: '700' },
  intro: { marginBottom: 23 },
  eyebrow: { color: COLORS.green, fontSize: 10, fontWeight: '800', letterSpacing: 1.05, marginBottom: 11 },
  headline: { color: COLORS.ink, fontSize: 38, lineHeight: 42, fontWeight: '800', letterSpacing: 0 },
  introText: { color: COLORS.muted, fontSize: 14, lineHeight: 21, marginTop: 11, maxWidth: 310 },
  modeSwitch: { flexDirection: 'row', padding: 4, backgroundColor: '#E8EEE6', borderRadius: 12, marginBottom: 14 },
  modeButton: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 40, borderRadius: 9 },
  modeButtonActive: { backgroundColor: COLORS.paper, shadowColor: '#1E382B', shadowOpacity: 0.07, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  modeButtonText: { color: COLORS.muted, fontSize: 12, fontWeight: '700' },
  modeButtonTextActive: { color: COLORS.ink },
  examCard: { borderRadius: 16, backgroundColor: COLORS.greenDark, padding: 20, overflow: 'hidden' },
  examCardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  cardEyebrow: { color: COLORS.lime, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  examCardTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: '700', marginTop: 8 },
  cardStamp: { borderColor: '#597465', borderWidth: 1, borderRadius: 9, width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  cardStampText: { color: COLORS.lime, fontSize: 12, fontWeight: '700' },
  examCardBody: { color: '#D0DDD4', fontSize: 13, lineHeight: 19, marginTop: 11, maxWidth: 280 },
  lengthSwitch: { flexDirection: 'row', gap: 8, marginTop: 16 },
  lengthButton: { paddingHorizontal: 12, height: 30, borderRadius: 8, borderWidth: 1, borderColor: '#3D5C4E', alignItems: 'center', justifyContent: 'center' },
  lengthButtonActive: { backgroundColor: COLORS.lime, borderColor: COLORS.lime },
  lengthButtonText: { color: '#D0DDD4', fontSize: 11, fontWeight: '700' },
  lengthButtonTextActive: { color: COLORS.greenDark },
  examMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 17, marginBottom: 17 },
  examMeta: { color: '#D0DDD4', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  metaDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: COLORS.orange, marginHorizontal: 10 },
  primaryButton: { minHeight: 50, borderRadius: 10, backgroundColor: COLORS.lime, paddingHorizontal: 15, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  primaryButtonText: { color: COLORS.greenDark, fontSize: 13, fontWeight: '800' },
  primaryArrow: { color: COLORS.greenDark, fontSize: 25, lineHeight: 26, fontWeight: '500' },
  pressed: { opacity: 0.82 },
  quickRow: { minHeight: 74, marginTop: 17, paddingVertical: 14, borderBottomWidth: 1, borderColor: COLORS.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  quickCopy: { flex: 1 },
  quickTitle: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  quickBody: { color: COLORS.muted, fontSize: 12, marginTop: 4 },
  quickButton: { paddingHorizontal: 13, paddingVertical: 10, borderRadius: 9, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.paper },
  quickButtonText: { color: COLORS.green, fontSize: 11, fontWeight: '800' },
  recentResult: { minHeight: 61, marginTop: 13, paddingHorizontal: 13, paddingVertical: 10, borderRadius: 10, backgroundColor: COLORS.paleGreen, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  recentResultCopy: { flex: 1 },
  recentResultLabel: { color: COLORS.green, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  recentResultTopic: { color: COLORS.ink, fontSize: 11, fontWeight: '700', marginTop: 4 },
  recentResultScore: { color: COLORS.greenDark, fontSize: 20, fontWeight: '800' },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 23, marginBottom: 9 },
  sectionTitle: { color: COLORS.ink, fontSize: 17, fontWeight: '800' },
  sectionNote: { color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  topicList: { backgroundColor: COLORS.paper, borderRadius: 13, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 13 },
  topicRow: { flexDirection: 'row', alignItems: 'center', minHeight: 65, borderBottomWidth: 1, borderBottomColor: '#EDF1EC' },
  topicNumber: { width: 32, height: 32, borderRadius: 10, backgroundColor: '#EEF2EC', alignItems: 'center', justifyContent: 'center' },
  topicNumberHighlight: { backgroundColor: COLORS.paleOrange },
  topicNumberText: { color: COLORS.muted, fontSize: 10, fontWeight: '800' },
  topicNumberTextHighlight: { color: '#AF573B' },
  topicCopy: { marginLeft: 11, flex: 1 },
  topicName: { color: COLORS.ink, fontSize: 13, fontWeight: '700' },
  topicCount: { color: COLORS.muted, fontSize: 9, fontWeight: '700', letterSpacing: 0.6, marginTop: 4 },
  topicArrow: { color: COLORS.muted, fontSize: 22, paddingHorizontal: 5 },
  footerNote: { marginTop: 21 },
  footerRule: { width: 27, height: 3, backgroundColor: COLORS.orange, marginBottom: 10 },
  footerText: { color: COLORS.muted, fontSize: 10, lineHeight: 15 },
  footerThanks: { marginTop: 8, color: COLORS.green },
  privacyButton: { alignSelf: 'flex-start', marginTop: 10, paddingVertical: 6 },
  privacyButtonText: { color: COLORS.green, fontSize: 11, fontWeight: '700', textDecorationLine: 'underline' },
  examContent: { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 32 },
  examHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 23 },
  closeButton: { width: 38, height: 38, borderRadius: 12, backgroundColor: COLORS.paper, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  closeButtonText: { color: COLORS.ink, fontSize: 25, lineHeight: 28, fontWeight: '400' },
  examHeaderCopy: { flex: 1, marginLeft: 11 },
  examHeaderKicker: { color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.9 },
  examHeaderTitle: { color: COLORS.ink, fontSize: 14, fontWeight: '700', marginTop: 3 },
  timerPill: { paddingHorizontal: 11, height: 34, borderRadius: 9, backgroundColor: COLORS.paleGreen, alignItems: 'center', justifyContent: 'center' },
  timerPillUrgent: { backgroundColor: COLORS.paleOrange },
  timerText: { color: COLORS.green, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  timerTextUrgent: { color: '#A34E34' },
  timerSpacer: { width: 56 },
  progressInfo: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  progressLabel: { color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  progressDivider: { color: '#AAB5AB' },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: '#E1E9DF', overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: COLORS.green, borderRadius: 2 },
  adPauseNotice: { marginTop: 14, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 10, backgroundColor: COLORS.paleGreen },
  adPauseTitle: { color: COLORS.greenDark, fontSize: 11, fontWeight: '800' },
  adPauseText: { color: COLORS.muted, fontSize: 10, marginTop: 3 },
  navigator: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16, marginBottom: 3 },
  navigatorItem: { width: 30, height: 30, borderRadius: 9, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.paper, alignItems: 'center', justifyContent: 'center' },
  navigatorItemCurrent: { backgroundColor: COLORS.greenDark, borderColor: COLORS.greenDark },
  navigatorItemAnswered: { backgroundColor: COLORS.paleGreen, borderColor: '#C9DCCB' },
  navigatorText: { color: COLORS.muted, fontSize: 10, fontWeight: '700' },
  navigatorTextActive: { color: COLORS.greenDark },
  flagDot: { position: 'absolute', top: -2, right: -2, width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.orange },
  questionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 24, marginBottom: 14 },
  topicPill: { backgroundColor: COLORS.paleGreen, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 6 },
  topicPillText: { color: COLORS.green, fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  flagButton: { paddingHorizontal: 9, paddingVertical: 7, borderRadius: 7, borderWidth: 1, borderColor: COLORS.line },
  flagButtonActive: { backgroundColor: COLORS.paleOrange, borderColor: '#F0C5B5' },
  flagButtonText: { color: COLORS.muted, fontSize: 8, fontWeight: '800', letterSpacing: 0.4 },
  flagButtonTextActive: { color: '#A34E34' },
  questionText: { color: COLORS.ink, fontSize: 21, lineHeight: 29, fontWeight: '700', letterSpacing: 0 },
  selectHint: { color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.7, marginTop: 20, marginBottom: 10 },
  optionsList: { gap: 9 },
  option: { minHeight: 57, borderRadius: 11, paddingVertical: 11, paddingHorizontal: 11, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.paper, flexDirection: 'row', alignItems: 'center' },
  optionSelected: { borderColor: '#67957D', backgroundColor: '#F0F6EF' },
  optionCorrect: { borderColor: '#76A789', backgroundColor: '#EAF5EA' },
  optionWrong: { borderColor: '#E6A48C', backgroundColor: '#FFF1EA' },
  optionLetter: { width: 28, height: 28, borderRadius: 8, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  optionLetterSelected: { backgroundColor: COLORS.green, borderColor: COLORS.green },
  optionLetterCorrect: { backgroundColor: COLORS.green, borderColor: COLORS.green },
  optionLetterWrong: { backgroundColor: COLORS.orange, borderColor: COLORS.orange },
  optionLetterText: { color: COLORS.muted, fontSize: 10, fontWeight: '800' },
  optionLetterTextActive: { color: COLORS.paper },
  optionText: { color: COLORS.ink, fontSize: 12, lineHeight: 17, flex: 1, marginLeft: 10 },
  optionTextActive: { fontWeight: '600' },
  explanationBox: { marginTop: 13, padding: 14, borderRadius: 11 },
  sourceNote: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(25, 51, 43, 0.12)' },
  sourceKicker: { color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  sourceQuote: { color: COLORS.ink, fontSize: 11, lineHeight: 16, fontStyle: 'italic', marginTop: 5 },
  sourceLink: { color: COLORS.green, fontSize: 11, fontWeight: '700', textDecorationLine: 'underline', marginTop: 6 },
  explanationCorrect: { backgroundColor: COLORS.paleGreen },
  explanationReview: { backgroundColor: COLORS.paleOrange },
  explanationKicker: { fontSize: 9, fontWeight: '800', letterSpacing: 0.7, marginBottom: 7 },
  explanationKickerCorrect: { color: COLORS.green },
  explanationKickerReview: { color: '#A34E34' },
  explanationText: { color: COLORS.ink, fontSize: 12, lineHeight: 18 },
  questionActions: { marginTop: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backButton: { minHeight: 46, justifyContent: 'center', paddingHorizontal: 5 },
  backButtonText: { color: COLORS.green, fontSize: 12, fontWeight: '700' },
  actionButton: { minHeight: 46, paddingHorizontal: 17, borderRadius: 9, backgroundColor: COLORS.greenDark, alignItems: 'center', justifyContent: 'center' },
  actionButtonDisabled: { opacity: 0.4 },
  actionButtonText: { color: COLORS.paper, fontSize: 12, fontWeight: '800' },
  resultsContent: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 38 },
  resultsHeadline: { color: COLORS.ink, fontSize: 37, lineHeight: 41, fontWeight: '800', marginBottom: 19 },
  scoreCard: { backgroundColor: COLORS.greenDark, borderRadius: 16, padding: 20, marginBottom: 25 },
  scoreKicker: { color: COLORS.lime, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  scoreLine: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  scoreValue: { color: COLORS.paper, fontSize: 58, lineHeight: 64, fontWeight: '800' },
  scorePercent: { color: COLORS.lime, fontSize: 21, fontWeight: '700', alignSelf: 'flex-start', marginTop: 10 },
  scoreDetail: { marginLeft: 15, marginTop: 9 },
  scoreDetailMain: { color: COLORS.paper, fontSize: 12, fontWeight: '700' },
  scoreDetailSub: { color: '#B6C8BD', fontSize: 10, marginTop: 4 },
  scoreRule: { height: 1, backgroundColor: '#486355', marginVertical: 12 },
  scoreMessage: { color: '#D0DDD4', fontSize: 12, lineHeight: 18 },
  resultTopic: { paddingVertical: 12, borderBottomWidth: 1, borderColor: COLORS.line },
  resultTopicTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  resultTopicName: { color: COLORS.ink, fontSize: 12, fontWeight: '700' },
  resultTopicCount: { color: COLORS.muted, fontSize: 11, fontWeight: '700' },
  resultTrack: { height: 4, backgroundColor: '#E3EAE1', borderRadius: 2, overflow: 'hidden' },
  resultFill: { height: 4, backgroundColor: COLORS.orange, borderRadius: 2 },
  reviewHeading: { color: COLORS.ink, fontSize: 17, fontWeight: '800', marginTop: 25, marginBottom: 10 },
  reviewList: { backgroundColor: COLORS.paper, borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, paddingHorizontal: 13 },
  reviewItem: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  reviewMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  reviewNumber: { color: COLORS.muted, fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  reviewOutcome: { fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  reviewOutcomeCorrect: { color: COLORS.green },
  reviewOutcomeMissed: { color: '#AF573B' },
  reviewPrompt: { color: COLORS.ink, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  reviewAnswer: { color: COLORS.green, fontSize: 11, lineHeight: 16, fontWeight: '700', marginTop: 8 },
  reviewYourAnswer: { color: '#AF573B', fontSize: 11, lineHeight: 16, marginTop: 3 },
  reviewExplanation: { color: COLORS.muted, fontSize: 11, lineHeight: 16, marginTop: 7 },
  resultActions: { gap: 9, marginTop: 23 },
  homeButton: { minHeight: 46, borderRadius: 9, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  homeButtonText: { color: COLORS.green, fontSize: 12, fontWeight: '700' },
  latestScoreNote: { marginTop: 17, color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  resultsDisclaimer: { color: COLORS.muted, fontSize: 10, lineHeight: 15, marginTop: 13 },
});
