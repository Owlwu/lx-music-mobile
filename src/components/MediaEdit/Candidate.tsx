import { Pressable, StyleSheet, View } from 'react-native'
import { type ReactNode } from 'react'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'

interface CandidateProps {
  children: ReactNode
  leading?: ReactNode
  label: string
  selected: boolean
  onPress: () => void
}

export default function MediaCandidate({ children, leading, label, selected, onPress }: CandidateProps) {
  const theme = useTheme()
  const accent = theme['c-primary-font']

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.card, {
        backgroundColor: selected ? theme['c-primary-background-active'] : theme['c-primary-input-background'],
        borderColor: selected ? accent : 'transparent',
        opacity: pressed ? 0.8 : 1,
      }]}
    >
      {leading}
      <View style={styles.body}>{children}</View>
      <View style={styles.indicator} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {selected ? <Icon name="checkbox-marked" size={14} color={accent} /> : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: 1,
    borderRadius: 6,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  indicator: {
    width: 20,
    alignItems: 'center',
  },
})
